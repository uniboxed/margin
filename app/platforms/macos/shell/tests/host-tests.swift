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
    // frame: a normal window's (none: 100,100 800×600). canFullScreen: AXFullScreen settable; resizable: AXSize settable;
    // minSize/maxSize: the app's own limits, kept when Accessibility sizes it.
    struct Win { var pid: pid_t; var fullScreen = false; var spaces: [UInt64]; var priv: UInt64?; var frame: CGRect? = nil
                 var canFullScreen = true; var resizable = true; var minSize: CGSize? = nil; var maxSize: CGSize? = nil; var minimized = false
                 // axRole: Accessibility's role/subrole when it isn't a standard window's (the listing, which keeps standard
                 // windows and ones that can go full screen, leaves it out; found by its number).
                 var axRole: String? = nil }
    static let defaultFrame = CGRect(x: 100, y: 100, width: 800, height: 600)

    static let marginSpace: UInt64 = 100, marginTile: UInt64 = 101, desktop: UInt64 = 1, marginWindow = 1
    static let display = CGRect(x: 0, y: 33, width: 1512, height: 949) // a full-screen Space's layout area
    // Margin's window's width as macOS lays its tile out (its content's max width); `narrowing`: a new width it takes
    // at that time on the clock (its resize animates), as Margin's window does after `willTile`.
    var marginWidth: CGFloat = 260
    var narrowing: (width: CGFloat, at: Double)?
    // A window whose tile just moved into Margin's Space keeps its full-screen frame (the whole area) this long, as
    // the real window manager reads mid-transition (2026-11-15: hosted 0,33 1512×949 with 0/7/8/8 already reserved).
    var tileLag = 0.0
    var movedAt: [Int: Double] = [:]

    var clock = 0.0
    var calls: [String] = []
    var fail: Set<String> = [] // launch, ax, fullScreen, exitFullScreen, moveTile, destroy, park, setCurrent
    var installed: Set<String> = ["com.apple.TextEdit", "com.apple.Notes", "com.apple.Safari", "com.apple.FaceTime", "com.apple.calculator", "com.apple.mobilephone"]
    // Apps whose windows can't go full screen (started with no Dock icon, as on the real Mac), a fixed size's, limits.
    var notFullScreen: Set<String> = ["com.apple.FaceTime", "com.apple.calculator", "com.apple.mobilephone"]
    var fixedSize: [String: CGSize] = ["com.apple.calculator": CGSize(width: 230, height: 408)]
    var maxSize: [String: CGSize] = [:]
    var minSize: [String: CGSize] = [:]
    var axRoles: [String: String] = [:] // an app's windows' Accessibility role/subrole when it isn't a standard window's
    // What each app last saved as its window's frame (AppKit writes it as the window moves or resizes, and at quit).
    var saved: [String: CGRect] = [:]
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
    // A window Accessibility listed once is still read and its full screen set through its element on another Space
    // (HostAX keeps them); its position and size only on the current Space (the kit's finding, 2026-11-15).
    var axCurrentOnly = false
    var axSeen: Set<Int> = []
    func onCurrent(_ window: Int) -> Bool { wins[window].map { $0.priv == nil && $0.spaces.contains(current) } ?? false }
    func axReads(_ window: Int) -> Bool { !axCurrentOnly || onCurrent(window) || axSeen.contains(window) }
    // Accessibility lists a window only this long after it's on the current Space (moved there, or its Space made
    // current): the window server moves it first (seen 2026-11-15: Calculator brought into Margin's Space, not listed
    // within a second). And windows it lists only while the Desktop is current (where a stand-alone test saw Calculator's).
    var axDelay = 0.0
    var arrivedAt: [Int: Double] = [:]
    var currentSince = 0.0
    var axDesktopOnly: Set<Int> = []
    var lookups = 0 // Accessibility asked for a window by its number
    func axLists(_ n: Int) -> Bool {
        guard !axCurrentOnly || onCurrent(n) else { return false }
        if axDesktopOnly.contains(n), current != Self.desktop { return false }
        return axDelay == 0 || clock - max(arrivedAt[n] ?? 0, currentSince) >= axDelay
    }
    // The window server's bounds of a window Accessibility just set: its old frame this long after (none: at once).
    var frameLag = 0.0
    var lagging: [Int: (frame: CGRect, until: Double)] = [:]
    var onSetFrame: (() async -> Void)? // (a test's: something that happens while a frame is being set)

    init() { wins[Self.marginWindow] = Win(pid: 1, spaces: [Self.marginSpace]) }

    func now() -> Double {
        if let n = narrowing, clock >= n.at { marginWidth = n.width; narrowing = nil }
        return clock
    }
    func narrow(to width: CGFloat, after seconds: Double) { narrowing = (width, clock + seconds) }
    func sleep(_ seconds: Double) async { clock += seconds; await Task.yield() }

    // ---- apps ----
    func running(bundleId: String) -> [HostApp] { apps.values.filter { $0.bundle == bundleId }.sorted { $0.pid < $1.pid }.map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: $0.launchedAt) } }
    func app(pid: pid_t) -> HostApp? { apps[pid].map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: $0.launchedAt) } }
    func policy(pid: pid_t) -> HostPolicy? { apps[pid]?.policy }
    @discardableResult func start(_ bundle: String, policy: HostPolicy, windows: Int) -> pid_t {
        let pid = nextPid
        nextPid += 1
        var list: [Int] = []
        for _ in 0..<windows {
            let n = nextWindow
            nextWindow += 1
            var win = Win(pid: pid, spaces: [Self.desktop])
            win.canFullScreen = !notFullScreen.contains(bundle)
            if let size = fixedSize[bundle] { win.resizable = false; win.frame = CGRect(origin: CGPoint(x: 400, y: 300), size: size) }
            win.maxSize = maxSize[bundle]
            win.minSize = minSize[bundle]
            win.axRole = axRoles[bundle]
            wins[n] = win
            list.append(n)
        }
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
    var frameAtQuit: [String: CGRect] = [:] // each app's window's frame as it was asked to quit
    func terminate(pid: pid_t) -> Bool {
        calls.append("terminate \(pid)")
        guard let a = apps[pid] else { return false }
        if let n = a.windows.first, let win = wins[n] { frameAtQuit[a.bundle] = win.frame ?? Self.defaultFrame }
        if a.refusesQuit { return true }
        quitNow(pid)
        return true
    }
    func quitNow(_ pid: pid_t) {
        guard let a = apps.removeValue(forKey: pid) else { return }
        if let n = a.windows.first, let w = wins[n] { saved[a.bundle] = w.frame ?? Self.defaultFrame } // (its frame at quit)
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
        let listed = a.windows.filter { axLists($0) && wins[$0].map { $0.axRole == nil || $0.canFullScreen } == true }
        axSeen.formUnion(listed)
        return listed.compactMap { n in
            wins[n].map { HostWindow(number: n, fullScreen: $0.fullScreen, canFullScreen: $0.canFullScreen, resizable: $0.resizable, minimized: $0.minimized) }
        }
    }
    func window(pid: pid_t, number: Int) async -> HostWindow? {
        lookups += 1
        guard !fail.contains("ax"), let a = apps[pid], a.windows.contains(number), axLists(number), let w = wins[number] else { return nil }
        axSeen.insert(number)
        return HostWindow(number: number, fullScreen: w.fullScreen, canFullScreen: w.canFullScreen, resizable: w.resizable, minimized: w.minimized, role: w.axRole ?? "AXWindow/AXStandardWindow")
    }
    func frame(pid: pid_t, window: Int) async -> CGRect? {
        guard !fail.contains("ax"), let w = wins[window], w.pid == pid, !axCurrentOnly || onCurrent(window), !w.fullScreen else { return nil }
        return w.frame ?? Self.defaultFrame
    }
    // Accessibility's position and size: only a window on the current Space (when axCurrentOnly), the app's own limits
    // kept, a fixed-size window only moved; the app saves the frame it took.
    func setFrame(pid: pid_t, window: Int, _ frame: CGRect, size: Bool) async -> Bool {
        calls.append("frame \(window) \(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))×\(Int(frame.height))\(size ? "" : " (moved)")")
        guard !fail.contains("ax"), !fail.contains("frame"), var w = wins[window], w.pid == pid, !axCurrentOnly || onCurrent(window), !w.fullScreen else { return false }
        guard axSeen.contains(window) || (w.axRole == nil && axLists(window)) else { return false } // (Accessibility has no element for it)
        var extent = (w.frame ?? Self.defaultFrame).size
        if size, w.resizable {
            extent = frame.size
            if let m = w.minSize { extent = CGSize(width: max(extent.width, m.width), height: max(extent.height, m.height)) }
            if let m = w.maxSize { extent = CGSize(width: min(extent.width, m.width), height: min(extent.height, m.height)) }
        }
        if frameLag > 0 { lagging[window] = (w.frame ?? Self.defaultFrame, clock + frameLag) }
        w.frame = CGRect(origin: frame.origin, size: extent)
        wins[window] = w
        if let bundle = apps[pid]?.bundle { saved[bundle] = w.frame }
        await onSetFrame?()
        return true
    }
    func activate(pid: pid_t, window: Int) async -> Bool { calls.append("activate \(pid) \(window)"); return apps[pid] != nil }
    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool {
        calls.append("fullScreen \(on) \(window)")
        guard axReads(window) else { return false }
        return applyFullScreen(pid: pid, window: window, on)
    }
    // Full screen as macOS does it, whoever asked (Accessibility, or a Safari copy's setWindowState).
    @discardableResult func applyFullScreen(pid: pid_t, window: Int, _ on: Bool) -> Bool {
        guard var w = wins[window], w.pid == pid else { return false }
        if on, !w.canFullScreen { return false } // (AXFullScreen isn't settable)
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
        guard axReads(window) else { return nil }
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
        if let lag = lagging[window], clock < lag.until { return lag.frame }
        guard w.priv == nil, let space = spaceOf(window: window), w.fullScreen || window == Self.marginWindow else { return w.frame ?? Self.defaultFrame }
        let sidebar = apps[w.pid]?.sidebarOpen == true
        let area = (sidebar ? .zero : (reservation[space] ?? .zero)).inset(Self.display)
        let list = tiles[space] ?? []
        _ = now() // (Margin's window's width at this time)
        if space == Self.marginSpace {
            if window == Self.marginWindow {
                return list.count == 1 ? CGRect(x: (Self.display.width - marginWidth) / 2, y: Self.display.minY, width: marginWidth, height: Self.display.height)
                    : CGRect(x: area.minX, y: area.minY, width: marginWidth, height: area.height)
            }
            if let at = movedAt[window], clock < at + tileLag { return Self.display } // (its full-screen frame still)
            let x = area.minX + marginWidth + CGFloat(spacing[space] ?? 12)
            return CGRect(x: x, y: area.minY, width: area.maxX - x, height: area.height)
        }
        return area
    }
    func spaces(window: Int) -> [UInt64]? { wins[window].map { $0.priv != nil ? [] : $0.spaces } }
    func spaceType(_ space: UInt64) -> Int? { tiles[space] != nil ? 4 : (space == Self.desktop ? 0 : nil) }
    func spaceExists(_ space: UInt64) -> Bool? { tiles[space] != nil || space == Self.desktop }
    func currentSpace(onDisplayOf space: UInt64) -> UInt64? { current }
    func setCurrentSpace(_ space: UInt64) -> Bool { calls.append("current \(space)"); guard !fail.contains("setCurrent") else { return false }; current = space; currentSince = clock; return true }
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
        if let n = tileWindow[tile] { movedAt[n] = clock }
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
        guard var w = wins[window], !(fail.contains("moveIn") && space == Self.marginSpace) else { return false }
        if privates.contains(space) {
            guard !fail.contains("park") else { return false }
            w.priv = space
        } else { w.priv = nil; w.spaces = [space]; arrivedAt[window] = clock }
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

    // Margin's window leaving full screen as macOS does it with a hosted tile beside it: Margin's Space goes, the
    // hosted window stands alone in a full-screen Space of its own (what the person saw, 2026-11-15).
    func marginLeavesFullScreen() {
        for tile in hostedTiles {
            guard let n = tileWindow[tile], let pid = wins[n]?.pid else { continue }
            let space = nextId
            nextId += 1
            tiles[space] = [tile]
            owner[space] = pid
            wins[n]?.spaces = [space]
        }
        tiles[Self.marginSpace] = [Self.marginTile]
    }

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
    var closesOnlyNormal = false // Safari closes only a normal window (on a Desktop, not full screen), as seen at quit 2026-11-15
    var closedAs: [String] = [] // each window as it was asked to close: "normal", "parked" or "full screen"
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
        if let n = windowOf[id], let w = world.wins[n] {
            let state = w.priv != nil ? "parked" : w.fullScreen ? "full screen" : "normal"
            closedAs.append(state)
            if closesOnlyNormal, state != "normal" { return true } // (asked; Safari doesn't)
        }
        if let n = windowOf.removeValue(forKey: id) { world.closeWindow(n) }
        return true
    }
    func fullScreen(_ id: Int, _ on: Bool) -> Bool {
        fullScreens.append("\(id) \(on ? "on" : "off")")
        world.calls.append("copy fullScreen \(id) \(on)")
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
    // Margin's window told to become the sidebar's tile while the hosted tile was beside it (its size constraints would
    // change while it's a tile: what took it out of full screen, 2026-11-15). Must stay 0.
    var tiledShared = 0
    func world() -> (FakeHostWorld, HostEngine, URL) {
        made += 1
        let w = FakeHostWorld()
        let url = folder.appendingPathComponent("\(made)/\(HostMarker.fileName)")
        let e = HostEngine(system: w, marker: url, pid: 1)
        e.willTile = { _ in if !w.hostedTiles.isEmpty { tiledShared += 1 } }
        return (w, e, url)
    }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933) // 16 pt after Margin's tile, 8 pt from the other edges
    @Sendable func placed(_ rect: CGRect, tile: CGFloat = 260) -> HostPlacement { HostPlacement(page: rect, area: FakeHostWorld.display, tileWidth: tile) }
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func open(_ e: HostEngine, _ t: HostTarget, _ rect: CGRect = page) -> HostResult? {
        hostRun { await e.open(app: t, in: placed(rect), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
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
        check("host: a new page area taken", hostRun { await e.pageRectChanged(placed(page2)) } == true && w.bounds(window: window) == page2 && w.spacing[FakeHostWorld.marginSpace] == 12)

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
        let r = hostRun { await e.open(app: textEdit, in: placed(page), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.desktop) }
        check("host: Margin's window not in a full-screen Space: refused, nothing started", { if case .failed(.margin, _)? = r { return true }; return false }() && w.apps.isEmpty)
    }

    // ---- a failure at each step falls back, leaving nothing ----
    for (what, step) in [("launch", HostStep.launch), ("ax", .window), ("moveTile", .tile)] {
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
        _ = hostRun { await e.pageRectChanged(placed(page)) } // the next operation, after the poll's retry
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
        copy.closesOnlyNormal = true
        w.calls = []
        hostRun { await e.quitAll() }
        check("host: quit: Margin's Safari window out of full screen and closed by its copy, Safari left running", copy.closed == [ext] && w.wins[mine] == nil && w.apps[safariPid] != nil && clean(w) && e.leftSafariWindows.isEmpty,
              "\(copy.closed) \(copy.closedAs) \(e.leftSafariWindows)")
        let normalAt = w.calls.firstIndex(of: "copy fullScreen 7914 false") ?? 99, closeAt = w.calls.firstIndex(of: "copy close 7914") ?? -1
        check("host: quit: the shown Safari window put normal by its copy, then closed as a normal window", normalAt < closeAt && copy.closedAs == ["normal"], "\(w.calls) \(copy.closedAs)")
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
        _ = hostRun { await e.pageRectChanged(placed(page)) } // the next operation, after the poll's try
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

    // ---- the reservation from the placement: the same whatever the windows' bounds mid-transition ----
    do {
        let (w, e, _) = world()
        w.tileLag = 1.0 // the hosted window keeps its full-screen frame for a second after its tile moves
        let want = SlotEdges(left: 0, right: 8, top: 8, bottom: 8)
        _ = open(e, textEdit)
        let a = w.apps[w.running(bundleId: "com.apple.TextEdit")[0].pid]!.windows[0]
        check("host: a tile that lags in its full-screen frame: placed at the page area, reserved once as planned", w.bounds(window: a) == page && w.reservation[FakeHostWorld.marginSpace] == want,
              "\(String(describing: w.reservation[FakeHostWorld.marginSpace])) \(w.calls.filter { $0.hasPrefix("reserve") })")
        for _ in 0..<3 {
            _ = open(e, notes)
            _ = hostRun { await e.show(textEdit.id) }
            _ = hostRun { await e.pageRectChanged(placed(page)) }
        }
        let reserves = Set(w.calls.filter { $0.hasPrefix("reserve") })
        check("host: switches and the same placement again, mid-transition each time: the reservation never grows", reserves == ["reserve \(want.text)"] && w.reservation[FakeHostWorld.marginSpace] == want,
              "\(reserves)")
        check("host: … and the window is at the page area after each", w.bounds(window: a) == page && clean(w))
    }

    // ---- Margin's window narrowing: waited for only when it really narrows, until it's there ----
    do {
        let (w, e, _) = world()
        w.marginWidth = 1512 // Margin's window alone in its Space, its whole width
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        e.willTile = { _ in if w.marginWidth != 260 { w.narrow(to: 260, after: 0.2) } } // (its resize animates)
        let t0 = w.clock
        _ = open(e, textEdit)
        let first = w.clock - t0
        let t1 = w.clock
        _ = open(e, notes)
        let second = w.clock - t1
        Diagnostics.echo = echo
        func tileStep(_ id: HostID) -> Int? {
            guard let line = lines.last(where: { $0.contains("host: \(id) shown in") }), let r = line.range(of: "tile ") else { return nil }
            return Int(line[r.upperBound...].prefix { $0.isNumber })
        }
        let a = tileStep(textEdit.id) ?? -1, b = tileStep(notes.id) ?? -1
        check("host: Margin's window narrowing: the tile step waits until it's at the tile's width and steady (200 ms here), never the fixed 2.1 s", a >= 200 && a <= 400 && w.marginWidth == 260, "tile \(a) ms, \(lines.filter { $0.contains("narrowed") })")
        check("host: Margin's window at the tile's width already (every switch after the first): no wait at all", b == 0 && lines.filter { $0.contains("narrowed") }.count == 1, "tile \(b) ms")
        check("host: the whole switch's time with Margin's tile already narrow, against the first open's", second < first && second < 0.5, "first \(first) s, second \(second) s")
        e.willTile = nil
    }

    // ---- Margin's window leaving full screen: the one shown parked at once, nothing left alone ----
    do {
        let (w, e, _) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, textEdit)
        let a = w.apps[w.running(bundleId: "com.apple.TextEdit")[0].pid]!.windows[0]
        hostRun { await e.parkShown(why: "Margin's window left full screen") }
        check("host: Margin's window leaving full screen: the one shown parked (private Space, out of full screen), nothing shown, said",
              e.shown == nil && e.hosts[textEdit.id]?.phase == .parked && w.wins[a]?.priv != nil && w.wins[a]?.fullScreen == false && events.last == .unshown(textEdit.id), "\(events)")
        check("host: … Margin's Space keeps its own tile only, its reservation given back, nothing ownerless", w.hostedTiles.isEmpty && w.reservation[FakeHostWorld.marginSpace] == .zero && clean(w))
        let back = open(e, textEdit)
        check("host: Margin in full screen again and the item shown: hosted again, fitted", back == .shown(textEdit.id, placed: true) && e.shown == textEdit.id && w.spaces(window: a) == [FakeHostWorld.marginSpace] && clean(w), "\(String(describing: back))")

        // macOS took Margin's window out of full screen first (no word of it before): the poll finds the one shown alone.
        w.marginLeavesFullScreen()
        let alone = w.spaces(window: a)?.first ?? 0
        check("host: (the stand-in) the hosted window alone in a full-screen Space of its own", alone != FakeHostWorld.marginSpace && w.spaceType(alone) == 4)
        e.poll()
        check("host: one read outside Margin's Space: not yet (a read can miss mid-transition)", e.shown == textEdit.id)
        e.poll()
        _ = hostRun { await e.pageRectChanged(placed(page)) } // (the next operation, after the poll's)
        check("host: found outside Margin's Space twice: parked at once, its own Space given back, nothing shown", e.shown == nil && e.hosts[textEdit.id]?.phase == .parked
              && w.wins[a]?.priv != nil && w.wins[a]?.fullScreen == false && w.tiles[alone] == nil && clean(w) && events.last == .unshown(textEdit.id), "\(w.tiles) \(events.suffix(3))")

        // A parked window macOS (or its app) put on a Desktop: parked again.
        w.wins[a]?.priv = nil
        w.wins[a]?.spaces = [FakeHostWorld.desktop]
        e.poll(); e.poll()
        _ = hostRun { await e.pageRectChanged(placed(page)) }
        check("host: a parked window found on a Desktop: parked again, out of sight", w.wins[a]?.priv != nil && w.spaces(window: a) == [] && e.hosts[textEdit.id]?.phase == .parked)
        hostRun { await e.quitAll() }
        check("host: … and quit as any", w.apps.isEmpty && clean(w))
    }

    // ---- another tile width: parked and brought in again, never resized while tiled ----
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let a = w.apps[w.running(bundleId: "com.apple.TextEdit")[0].pid]!.windows[0]
        var tiles = 0
        e.willTile = { _ in
            tiles += 1
            if !w.hostedTiles.isEmpty { tiledShared += 1 }
            w.marginWidth = 300 // (Margin's window takes the new width, alone in its Space)
        }
        let wider = CGRect(x: 316, y: 41, width: 1188, height: 933)
        let r = hostRun { await e.pageRectChanged(placed(wider, tile: 300)) }
        check("host: a new tile width (another theme): parked and brought in again beside it, fitted", r == true && tiles == 1 && w.bounds(window: a) == wider && e.shown == textEdit.id && e.tiledWidth == 300 && clean(w),
              "\(String(describing: r)) \(String(describing: w.bounds(window: a)))")
        let again = hostRun { await e.pageRectChanged(placed(CGRect(x: 316, y: 61, width: 1188, height: 900), tile: 300)) }
        check("host: the same width, other edges: only reserved again, nothing re-tiled", again == true && tiles == 1)
        e.willTile = nil
    }
    check("host: Margin's window never made the sidebar's tile while a hosted tile was beside it", tiledShared == 0, "\(tiledShared)")

    // ---- quit: a parked Safari window made a normal one before its copy closes it ----
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        copy.closesOnlyNormal = true
        _ = open(e, .safariWindow(nil))
        let mine = copy.windowOf[7914] ?? 0
        _ = open(e, textEdit) // Safari's window parked
        check("host: (Safari's window parked)", w.wins[mine]?.priv != nil && e.hosts[HostTarget.safariWindow(nil).id]?.phase == .parked)
        hostRun { await e.quitAll() }
        check("host: quit: a parked Safari window out of its private Space onto the Desktop, then closed by its copy as a normal window", copy.closedAs == ["normal"] && w.wins[mine] == nil && e.leftSafariWindows.isEmpty && w.privates.isEmpty && clean(w),
              "\(copy.closedAs) \(e.leftSafariWindows)")
        check("host: quit: Safari (not Margin's) left running, the app Margin started quit", w.apps[safariPid] != nil && w.running(bundleId: "com.apple.TextEdit").isEmpty)
    }

    windowModeTests(world: world)
    check("host: Margin's window never made the sidebar's tile while a hosted tile was beside it (window mode too)", tiledShared == 0, "\(tiledShared)")

    // ---- one at a time ----
    do {
        let (w, e, _) = world()
        let both = hostRun { () async -> [HostResult] in
            async let one = e.open(app: textEdit, in: placed(page), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace)
            async let two = e.open(app: notes, in: placed(page), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace)
            return await [one, two]
        }
        check("host: two opens at once run one after the other: both shown in turn, two tiles", both?.allSatisfy { if case .shown = $0 { return true }; return false } == true && w.tiles[FakeHostWorld.marginSpace]?.count == 2 && clean(w), "\(String(describing: both))")
    }
}

// Window mode (apps that can't go full screen) and apps the person opened (2026-11-15): the stand-in's FaceTime,
// Calculator and Phone windows can't go full screen (as with no Dock icon on the real Mac); Calculator is a fixed
// 230×408; every Accessibility frame set is in `calls` ("frame <window> …"), and each app's saved frame (`saved`, what
// AppKit writes as a window moves and at quit) and its frame as it was asked to quit (`frameAtQuit`) are kept.
func windowModeTests(world: () -> (FakeHostWorld, HostEngine, URL)) {
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let original = FakeHostWorld.defaultFrame
    let faceTime = HostTarget.app("com.apple.FaceTime"), calculator = HostTarget.app("com.apple.calculator"), phone = HostTarget.app("com.apple.mobilephone")
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func tiled(_ rect: CGRect = page) -> HostPlacement { HostPlacement(page: rect, area: FakeHostWorld.display, tileWidth: 260) }
    func windowed(_ rect: CGRect = page) -> HostPlacement { HostPlacement(page: rect, area: FakeHostWorld.display, tileWidth: 0, windowed: true) }
    func open(_ e: HostEngine, _ t: HostTarget) -> HostResult? {
        hostRun { await e.open(app: t, in: tiled(), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func clean(_ w: FakeHostWorld) -> Bool { w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && w.destroyedWithTiles == 0 }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func pid(_ w: FakeHostWorld, _ bundle: String) -> pid_t { w.running(bundleId: bundle).first?.pid ?? 0 }
    func at(_ w: FakeHostWorld, _ call: String) -> Int { w.calls.firstIndex(of: call) ?? -1 }
    func last(_ w: FakeHostWorld, _ prefix: String) -> Int { w.calls.lastIndex { $0.hasPrefix(prefix) } ?? -1 }
    func frameCall(_ n: Int, _ r: CGRect, moved: Bool = false) -> String { "frame \(n) \(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))×\(Int(r.height))\(moved ? " (moved)" : "")" }
    // The engine as the shell wires it: Margin's window's own page area for a window (willWindow), kept below it.
    final class Hooks { var windows = 0; var tiles = 0; var above: [Int?] = [] }
    func wired(_ e: HostEngine) -> Hooks {
        let h = Hooks()
        let tile = e.willTile
        e.willTile = { tile?($0); h.tiles += 1 }
        e.willWindow = { _ in h.windows += 1; return windowed() }
        e.keepAbove = { h.above.append($0) }
        return h
    }

    // ---- an app that can't go full screen, started by Margin: window mode ----
    do {
        let (w, e, marker) = world()
        let h = wired(e)
        let r = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime"), n = window(w, "com.apple.FaceTime")
        check("window mode: FaceTime (AXFullScreen not settable) shown, fitted to the page area", r == .shown(faceTime.id, placed: true) && e.mode(of: faceTime.id) == .window, "\(String(describing: r))")
        check("window mode: started with no Dock icon, never put in full screen, no Space of its own", w.apps[p]?.policy == .accessory && w.wins[n]?.fullScreen == false
              && !w.calls.contains("fullScreen true \(n)") && w.tiles.count == 1 && clean(w), "\(w.calls)")
        check("window mode: its window in Margin's Space as a window (the bridge), at the page area by Accessibility (position and size)",
              w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.bounds(window: n) == page && w.calls.contains(frameCall(n, page)) && at(w, "move \(n) \(FakeHostWorld.marginSpace)") < at(w, frameCall(n, page)), "\(w.calls)")
        check("window mode: no tile, no narrowing, nothing reserved: Margin's window its whole width (willWindow asked, willTile never)",
              h.tiles == 0 && h.windows == 1 && w.hostedTiles.isEmpty && (w.reservation[FakeHostWorld.marginSpace] ?? .zero) == .zero && !w.calls.contains { $0.hasPrefix("tile") } && e.tiledWidth == nil)
        check("window mode: Margin's window kept below it (keepAbove its number)", h.above == [n] && e.windowedShown == n, "\(h.above)")
        check("window mode: under one freeze, revealed", w.freezes == 1 && w.reveals == 1)
        let m = HostMarker.read(marker)?.windows.first
        check("window mode: the marker has its mode, its frame and Space before Margin moved it, and that its frame is changed",
              m?.mode == .window && m?.frame == original && m?.originalSpace == FakeHostWorld.desktop && m?.frameChanged == true && m?.personApp == false && m?.bundleId == "com.apple.FaceTime", "\(String(describing: m))")

        // the page area moves (a sidebar toggle, another theme): placed again, never parked
        let page2 = CGRect(x: 320, y: 41, width: 1184, height: 933)
        w.calls = []
        check("window mode: a new page area: placed again by Accessibility, not parked", hostRun { await e.pageRectChanged(windowed(page2)) } == true && w.bounds(window: n) == page2
              && w.calls == [frameCall(n, page2)], "\(w.calls)")
        hostRun { await e.activateShown() }
        check("window mode: a press in the page area around it: its app in front, its window raised (no click)", w.calls.last == "activate \(p) \(n)")

        // switching to an app shown full screen, and back
        w.axCurrentOnly = true // (Accessibility sees only the current Space's windows, as on the real Mac)
        w.calls = []
        let t = open(e, textEdit)
        let tw = window(w, "com.apple.TextEdit")
        check("window mode → full screen: TextEdit tiled beside Margin's sidebar tile, fitted", t == .shown(textEdit.id, placed: true) && w.hostedTiles.count == 1 && h.tiles == 1 && w.bounds(window: tw) == page, "\(String(describing: t))")
        check("window mode → full screen: FaceTime's frame given back on the current Space, then parked in a private Space (no full-screen exit)",
              w.wins[n]?.frame == original && w.wins[n]?.priv != nil && at(w, frameCall(n, original)) >= 0 && at(w, frameCall(n, original)) < last(w, "move \(n) ") && !w.calls.contains("fullScreen false \(n)"), "\(w.calls)")
        check("window mode → full screen: Margin's window no longer kept below anything; FaceTime saved its own frame", h.above.last == .some(nil) && e.windowedShown == nil && w.saved["com.apple.FaceTime"] == original, "\(h.above)")
        w.calls = []
        let back = hostRun { await e.show(faceTime.id) }
        check("full screen → window mode: FaceTime back in Margin's Space at the page area, TextEdit parked out of full screen", back == .shown(faceTime.id, placed: true) && w.spaces(window: n) == [FakeHostWorld.marginSpace]
              && w.bounds(window: n) == page && w.wins[tw]?.priv != nil && w.wins[tw]?.fullScreen == false && e.hosts[textEdit.id]?.phase == .parked && clean(w), "\(String(describing: back)) \(w.calls)")
        check("full screen → window mode: the tiles' reservation given back (Margin's window its whole width), Margin's window kept below FaceTime again",
              (w.reservation[FakeHostWorld.marginSpace] ?? .zero) == .zero && w.hostedTiles.isEmpty && h.above.last == .some(n) && h.windows == 2 && w.privates.count == 1)

        // quit: its frame back before it's quit
        w.calls = []
        hostRun { await e.quitAll() }
        check("window mode: quit: FaceTime's frame given back before it's quit, so it saves the frame it had", at(w, frameCall(n, original)) >= 0 && at(w, frameCall(n, original)) < at(w, "terminate \(p)")
              && w.frameAtQuit["com.apple.FaceTime"] == original && w.saved["com.apple.FaceTime"] == original, "\(w.calls)")
        check("window mode: quit: both apps quit, nothing left, the marker gone", w.apps.isEmpty && w.privates.isEmpty && clean(w) && !FileManager.default.fileExists(atPath: marker.path) && h.above.last == .some(nil))
    }

    // ---- a fixed-size window (Calculator): centred; one with a maximum size: that size, centred ----
    do {
        let (w, e, _) = world()
        _ = wired(e)
        let r = open(e, calculator)
        let n = window(w, "com.apple.calculator"), p = pid(w, "com.apple.calculator")
        let want = CGRect(x: 775, y: 304, width: 230, height: 408)
        check("window mode: a fixed-size window (Calculator 230×408) centred in the page area, only moved", r == .shown(calculator.id, placed: true) && w.bounds(window: n) == want
              && w.calls.contains(frameCall(n, want, moved: true)), "\(String(describing: w.bounds(window: n))) \(w.calls)")
        w.axCurrentOnly = true
        hostRun { await e.close(calculator.id) }
        check("window mode: Calculator closed: back at its own place, then quit; its saved frame as it was", w.frameAtQuit["com.apple.calculator"] == CGRect(x: 400, y: 300, width: 230, height: 408)
              && w.saved["com.apple.calculator"] == CGRect(x: 400, y: 300, width: 230, height: 408) && w.apps[p] == nil && clean(w), "\(w.calls)")
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.maxSize["com.apple.FaceTime"] = CGSize(width: 1000, height: 700)
        let r = open(e, faceTime)
        let n = window(w, "com.apple.FaceTime")
        check("window mode: a window with its own maximum size: that size, centred in what's left", r == .shown(faceTime.id, placed: true) && w.bounds(window: n) == CGRect(x: 390, y: 158, width: 1000, height: 700),
              "\(String(describing: w.bounds(window: n)))")
        hostRun { await e.quitAll() }
    }

    // ---- a window Accessibility lists late, or not as a standard window, or only with its Desktop current (Calculator,
    // 2026-11-15: started while Margin's Space was current, its window opened on the Desktop) ----
    func said(_ body: () -> Void) -> [String] {
        let echo = Diagnostics.echo
        var lines: [String] = []
        Diagnostics.echo = { lines.append($0) }
        body()
        Diagnostics.echo = echo
        return lines
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.axCurrentOnly = true
        w.axDelay = 1.5 // (listed 1.5 s after it's in Margin's Space: the old 1 s look gave up)
        var r: HostResult?
        let lines = said { r = open(e, calculator) }
        let n = window(w, "com.apple.calculator")
        let want = CGRect(x: 775, y: 304, width: 230, height: 408)
        check("window mode: Accessibility lists the window 1.5 s after it's in Margin's Space: asked by its number until then, hosted, centred",
              r == .shown(calculator.id, placed: true) && w.bounds(window: n) == want && w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.lookups >= 20, "\(String(describing: r)) \(w.lookups) \(w.calls)")
        check("window mode: found in Margin's Space, the Desktop never made current; the log says which path found it",
              !w.calls.contains("current \(FakeHostWorld.desktop)") && lines.contains { $0.contains("Accessibility found its window in Margin's Space after") && $0.contains("AXWindow/AXStandardWindow") }, "\(lines.filter { $0.contains("Accessibility") })")
        hostRun { await e.quitAll() }
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.axCurrentOnly = true
        w.axRoles["com.apple.calculator"] = "AXWindow/AXDialog" // (no settable full screen: the listing leaves it out)
        var r: HostResult?
        let lines = said { r = open(e, calculator) }
        let before = w.apps.values.first?.windows.first ?? -1
        let n = window(w, "com.apple.calculator")
        check("window mode: a window Accessibility lists with another subrole (AXDialog), never in the standard listing: found by its number, hosted",
              n == before && r == .shown(calculator.id, placed: true) && w.spaces(window: n) == [FakeHostWorld.marginSpace] && e.mode(of: calculator.id) == .window
              && lines.contains { $0.contains("by its number, AXWindow/AXDialog") }, "\(String(describing: r)) \(lines.filter { $0.contains("Accessibility") })")
        hostRun { await e.quitAll() }
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.axCurrentOnly = true
        let next = w.nextWindow
        w.axDesktopOnly = [next] // (listed only while the Desktop is current, as the stand-alone test saw it)
        var r: HostResult?
        let lines = said { r = open(e, calculator) }
        let n = window(w, "com.apple.calculator")
        let desk = at(w, "current \(FakeHostWorld.desktop)"), back = last(w, "current \(FakeHostWorld.marginSpace)")
        check("window mode: not listed in Margin's Space: read once with its Desktop current, then back in Margin's Space, hosted, centred",
              n == next && r == .shown(calculator.id, placed: true) && w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.current == FakeHostWorld.marginSpace
              && desk >= 0 && back > desk && w.bounds(window: n) == CGRect(x: 775, y: 304, width: 230, height: 408), "\(String(describing: r)) \(w.calls)")
        check("window mode: the Desktop made current only under the freeze (one, revealed after), the log says so",
              w.freezes == 1 && w.reveals == 1 && lines.contains { $0.contains("with its Desktop current it found it") }, "\(lines.filter { $0.contains("Accessibility") })")
        hostRun { await e.quitAll() }
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.axCurrentOnly = true
        w.axDesktopOnly = [w.nextWindow]
        w.fail = ["setCurrent"] // (and its Desktop can't be made current either)
        let r = open(e, calculator)
        check("window mode: not listed anywhere: not hosted, said so; Calculator quit, Margin's Space current, nothing left",
              r == .failed(.window, "Accessibility doesn't list its window, even on the current Space or with its Desktop current") && w.running(bundleId: "com.apple.calculator").isEmpty
              && w.current == FakeHostWorld.marginSpace && w.privates.isEmpty && clean(w) && e.hosts.isEmpty, "\(String(describing: r))")
    }

    // ---- the keyboard to the app only on a press around its window; giving a window back never activates its app ----
    do {
        let (w, e, _) = world()
        _ = wired(e)
        _ = open(e, calculator)
        let p = pid(w, "com.apple.calculator"), n = window(w, "com.apple.calculator")
        let on = CGPoint(x: 800, y: 400), around = CGPoint(x: 300, y: 100) // (Calculator at 775,304 230×408 in the page area)
        w.calls = []
        hostRun { await e.activateShown(at: on) }
        check("window mode: a press on the hosted window itself: the app's already, not activated again", !w.calls.contains { $0.hasPrefix("activate") }, "\(w.calls)")
        hostRun { await e.activateShown(at: around) }
        check("window mode: a press in the page area around it: its app given the keyboard", w.calls == ["activate \(p) \(n)"], "\(w.calls)")
        // A press while its window is given back (a switch parks it, then Margin quits): never activated.
        w.calls = []
        w.onSetFrame = { await e.activateShown(at: around) }
        _ = open(e, textEdit)
        check("window mode: parked by a switch (its frame given back): its app never activated, even with a press meanwhile",
              w.wins[n]?.priv != nil && !w.calls.contains { $0.hasPrefix("activate") }, "\(w.calls)")
        _ = hostRun { await e.show(calculator.id) }
        w.calls = []
        hostRun { await e.quitAll() }
        hostRun { await e.activateShown(at: around) }
        check("window mode: Margin quits: its frame given back and the app quit (a polite quit, once), never activated, nor after",
              w.calls.contains(frameCall(n, CGRect(x: 400, y: 300, width: 230, height: 408), moved: true)) && w.calls.filter { $0 == "terminate \(p)" }.count == 1
              && !w.calls.contains { $0.hasPrefix("activate") } && w.apps[p] == nil, "\(w.calls)")
    }
    do {
        // An app that doesn't quit within 5 s: left running, and the log says what can be read of why.
        let (w, e, _) = world()
        _ = wired(e)
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime")
        w.apps[p]?.refusesQuit = true
        w.serverExtra = [ServerWindow(number: 9001, pid: p, layer: 8, bounds: CGRect(x: 600, y: 400, width: 300, height: 160))] // (an alert of its own)
        let lines = said { hostRun { await e.quitAll() } }
        check("window mode: an app that doesn't quit within 5 s: asked politely once, left running, the log says why it may be",
              w.calls.filter { $0 == "terminate \(p)" }.count == 1 && w.apps[p] != nil
              && lines.contains { $0.contains("didn't quit within 5 s (still no Dock icon; 1 other window of its own on screen (it may be asking something); Accessibility still answers for it)") },
              "\(lines.filter { $0.contains("quit") })")
    }

    // ---- placing a window: as soon as it's there, or as soon as it holds the size it took ----
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.maxSize["com.apple.FaceTime"] = CGSize(width: 1000, height: 700)
        _ = open(e, faceTime)
        let n = window(w, "com.apple.FaceTime")
        let page2 = CGRect(x: 320, y: 41, width: 1184, height: 933)
        w.calls = []
        let t0 = w.clock
        let ok = hostRun { await e.pageRectChanged(windowed(page2)) }
        let took = w.clock - t0
        check("window mode: placed at its own maximum: done once its size held for 100 ms (not a fixed 1.5 s), centred",
              ok == true && took < 0.3 && w.bounds(window: n) == CGRect(x: 412, y: 158, width: 1000, height: 700) && w.calls.count == 2, "\(took) s \(w.calls)")
        w.frameLag = 0.3 // (the window server's bounds 300 ms behind Accessibility)
        w.calls = []
        let t1 = w.clock
        let ok2 = hostRun { await e.pageRectChanged(windowed(page)) }
        check("window mode: the window server's bounds late: waited for (no second set), done as soon as they're there",
              ok2 == true && w.clock - t1 < 1.0 && w.bounds(window: n) == CGRect(x: 390, y: 158, width: 1000, height: 700) && w.calls.count == 2, "\(w.clock - t1) s \(w.calls)")
        hostRun { await e.quitAll() }
    }

    // ---- full screen that fails: backed out, then window mode ----
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.fail = ["fullScreen"] // (its AXFullScreen is settable, but no full-screen Space ever comes)
        let r = open(e, textEdit)
        let n = window(w, "com.apple.TextEdit"), p = pid(w, "com.apple.TextEdit")
        check("full screen fails: backed out, shown in window mode, fitted", r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .window && w.bounds(window: n) == page
              && w.wins[n]?.fullScreen == false && w.tiles.count == 1 && clean(w), "\(String(describing: r))")
        w.fail = []
        hostRun { await e.close(textEdit.id) }
        check("full screen fails: closed: its frame back, then quit", w.frameAtQuit["com.apple.TextEdit"] == original && w.apps[p] == nil && clean(w))
    }

    // ---- an app the person opened (Phone, its Dock icon), its window on their Desktop ----
    do {
        let (w, e, marker) = world()
        let h = wired(e)
        let p = w.start("com.apple.mobilephone", policy: .regular, windows: 1)
        let n = w.apps[p]!.windows[0]
        w.axCurrentOnly = true // (its window on the Desktop: Accessibility doesn't list it while Margin's Space is current)
        let r = open(e, phone)
        check("person's app: Phone, already running, hosted (not refused), fitted, in window mode", r == .shown(phone.id, placed: true) && e.mode(of: phone.id) == .window && w.bounds(window: n) == page, "\(String(describing: r)) \(w.calls)")
        check("person's app: never started again, its Dock icon left, not Margin's to quit", !w.calls.contains { $0.hasPrefix("launch") } && w.apps[p]?.policy == .regular && e.launched.isEmpty)
        check("person's app: found by the window server, brought into Margin's Space before Accessibility sets anything", at(w, "move \(n) \(FakeHostWorld.marginSpace)") >= 0 && at(w, "move \(n) \(FakeHostWorld.marginSpace)") < last(w, "frame \(n)") && h.above.last == .some(n))
        let m = HostMarker.read(marker)?.windows.first
        check("person's app: the marker says it's the person's, its launch, its frame and its Desktop", m?.personApp == true && m?.appLaunchedAt == w.apps[p]?.launchedAt && m?.frame == original && m?.originalSpace == FakeHostWorld.desktop && HostMarker.read(marker)?.apps.isEmpty == true)
        w.calls = []
        hostRun { await e.close(phone.id) }
        check("person's app: closed: its frame given back (on the current Space), then back on its Desktop, still running, never quit",
              w.wins[n]?.frame == original && w.spaces(window: n) == [FakeHostWorld.desktop] && w.apps[p] != nil && !w.calls.contains("terminate \(p)")
              && at(w, frameCall(n, original)) >= 0 && at(w, frameCall(n, original)) < at(w, "move \(n) \(FakeHostWorld.desktop)") && w.saved["com.apple.mobilephone"] == original, "\(w.calls)")
        check("person's app: nothing left: no private Space, the marker gone, Margin's window kept below nothing", w.privates.isEmpty && clean(w) && !FileManager.default.fileExists(atPath: marker.path) && h.above.last == .some(nil))
    }
    do {
        // Phone parked behind a full-screen app, then Margin quits: back on its Desktop as it was, running.
        let (w, e, _) = world()
        _ = wired(e)
        let p = w.start("com.apple.mobilephone", policy: .regular, windows: 1)
        let n = w.apps[p]!.windows[0]
        w.axCurrentOnly = true
        _ = open(e, phone)
        w.axCurrentOnly = false
        _ = open(e, notes)
        w.axCurrentOnly = true
        check("person's app parked: its frame already given back, in a private Space", w.wins[n]?.priv != nil && w.wins[n]?.frame == original)
        hostRun { await e.quitAll() }
        check("person's app parked, Margin quits: back on its Desktop at its frame, still running; the app Margin started quit",
              w.spaces(window: n) == [FakeHostWorld.desktop] && w.wins[n]?.frame == original && w.apps[p] != nil && !w.calls.contains("terminate \(p)") && w.running(bundleId: "com.apple.Notes").isEmpty && w.privates.isEmpty && clean(w))
    }
    do {
        // The person's app whose window can go full screen: hosted full screen, given back out of it, on its Desktop.
        let (w, e, _) = world()
        let h = wired(e)
        let p = w.start("com.apple.TextEdit", policy: .regular, windows: 1)
        let n = w.apps[p]!.windows[0]
        w.axCurrentOnly = true
        let r = open(e, textEdit)
        check("person's app that can go full screen: read in Margin's Space, then tiled, fitted", r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .fullScreen && w.hostedTiles.count == 1 && h.tiles == 1 && w.bounds(window: n) == page,
              "\(String(describing: r)) \(w.calls)")
        _ = open(e, notes) // (parked behind another)
        hostRun { await e.close(textEdit.id) }
        check("person's app that can go full screen: closed while parked: out of full screen, on its Desktop, its frame as it was, running",
              w.wins[n]?.fullScreen == false && w.spaces(window: n) == [FakeHostWorld.desktop] && w.wins[n]?.priv == nil && (w.wins[n]?.frame ?? original) == original && w.apps[p] != nil && !w.calls.contains("terminate \(p)") && clean(w), "\(w.calls)")
        hostRun { await e.quitAll() }
    }
    do {
        // The person's window already full screen in a Space of its own: left alone.
        let (w, e, _) = world()
        w.jumpOnFullScreen = false
        let p = w.start("com.apple.TextEdit", policy: .regular, windows: 1)
        let n = w.apps[p]!.windows[0]
        w.applyFullScreen(pid: p, window: n, true)
        let theirs = w.spaces(window: n) ?? []
        w.calls = []
        let r = open(e, textEdit)
        check("person's app already full screen in its own Space: not hosted, said why, its window never touched", { if case .failed(.fullScreen, let why)? = r { return why.contains("already in full screen") }; return false }()
              && !w.calls.contains { $0.hasPrefix("move") || $0.hasPrefix("fullScreen") || $0.hasPrefix("frame") || $0.hasPrefix("tile") } && w.spaces(window: n) == theirs && w.wins[n]?.fullScreen == true && w.apps[p] != nil, "\(String(describing: r)) \(w.calls)")
    }

    // ---- Margin's window leaving full screen while a window is shown ----
    do {
        let (w, e, _) = world()
        let h = wired(e)
        _ = open(e, faceTime)
        let n = window(w, "com.apple.FaceTime")
        w.axCurrentOnly = true
        hostRun { await e.parkShown(why: "Margin's window left full screen") }
        check("window mode: Margin's window leaving full screen: the window's frame given back, then parked, nothing shown", w.wins[n]?.priv != nil && w.wins[n]?.frame == original && e.shown == nil && h.above.last == .some(nil))
        let again = open(e, faceTime)
        check("window mode: shown again: back at the page area", again == .shown(faceTime.id, placed: true) && w.bounds(window: n) == page && h.above.last == .some(n))
        hostRun { await e.quitAll() }
    }

    // ---- the restore always runs before an app Margin started is quit, whatever the path ----
    let paths = ["closed while shown", "closed while parked", "Margin quits while shown", "Margin quits while parked", "parked as Margin left full screen, then quit",
                 "a failed switch that couldn't park it, then quit", "its own show failing", "the next launch after a crash"]
    for path in paths {
        let (w, e, marker) = world()
        _ = wired(e)
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime"), n = window(w, "com.apple.FaceTime")
        w.axCurrentOnly = true
        switch path {
        case "closed while shown": hostRun { await e.close(faceTime.id) }
        case "closed while parked": w.axCurrentOnly = false; _ = open(e, notes); w.axCurrentOnly = true; hostRun { await e.close(faceTime.id) }
        case "Margin quits while shown": hostRun { await e.quitAll() }
        case "Margin quits while parked": w.axCurrentOnly = false; _ = open(e, notes); w.axCurrentOnly = true; hostRun { await e.quitAll() }
        case "parked as Margin left full screen, then quit": hostRun { await e.parkShown(why: "test") }; hostRun { await e.quitAll() }
        case "a failed switch that couldn't park it, then quit":
            w.axCurrentOnly = false
            w.fail = ["park"]
            let r = open(e, notes)
            w.fail = []
            check("restore before quit: \(path): the switch failed, FaceTime still shown at the page area", { if case .failed? = r { return true }; return false }() && e.shown == faceTime.id && w.bounds(window: n) == page, "\(String(describing: r))")
            w.axCurrentOnly = true
            hostRun { await e.quitAll() }
        case "its own show failing":
            hostRun { await e.close(faceTime.id) }
            w.fail = ["moveIn"]
            let r = open(e, faceTime)
            w.fail = []
            check("restore before quit: \(path): failed, given back", { if case .failed(.windowMode, _)? = r { return true }; return false }() && w.apps.isEmpty, "\(String(describing: r))")
        default: // a crash: Margin's Space goes with it, its window in no Space; the next launch reads the marker
            w.onAppQuit = nil
            w.tiles[FakeHostWorld.marginSpace] = nil
            w.wins[n]?.spaces = []
            w.current = FakeHostWorld.desktop
            let next = HostEngine(system: w, marker: marker, pid: 2)
            hostRun { await next.recover() }
        }
        hostRun { await e.quitAll() } // (whatever else is hosted: the next check's "nothing left")
        let started = w.running(bundleId: "com.apple.FaceTime")
        check("restore before quit: \(path): FaceTime's frame was the one it had when it was asked to quit, and that's what it saved",
              w.frameAtQuit["com.apple.FaceTime"] == original && w.saved["com.apple.FaceTime"] == original && started.isEmpty && w.apps[p] == nil, "\(String(describing: w.frameAtQuit)) \(w.calls.suffix(8))")
        check("restore before quit: \(path): nothing left", w.privates.isEmpty && clean(w) && !FileManager.default.fileExists(atPath: marker.path), "\(w.privates) \(w.tiles)")
    }

    // ---- a crash with the person's app shown in window mode: given back at the next launch, never quit ----
    do {
        let (w, e, marker) = world()
        _ = wired(e)
        let p = w.start("com.apple.mobilephone", policy: .regular, windows: 1)
        let n = w.apps[p]!.windows[0]
        _ = open(e, faceTime) // (Margin's: parked once Phone is shown)
        let f = window(w, "com.apple.FaceTime"), fp = pid(w, "com.apple.FaceTime")
        w.axCurrentOnly = true
        _ = open(e, phone)
        check("crash: (Phone shown at the page area, FaceTime parked at its own frame)", w.bounds(window: n) == page && w.wins[f]?.priv != nil && w.wins[f]?.frame == original)
        w.onAppQuit = nil
        w.tiles[FakeHostWorld.marginSpace] = nil
        w.wins[n]?.spaces = []
        w.current = FakeHostWorld.desktop
        w.calls = []
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        check("crash: the person's Phone back on its Desktop at its frame, still running, never quit", w.spaces(window: n) == [FakeHostWorld.desktop] && w.wins[n]?.frame == original && w.apps[p] != nil
              && !w.calls.contains("terminate \(p)") && w.saved["com.apple.mobilephone"] == original, "\(w.calls)")
        check("crash: FaceTime (Margin's) out of its private Space and quit at its own frame", w.apps[fp] == nil && w.frameAtQuit["com.apple.FaceTime"] == original && w.privates.isEmpty && !FileManager.default.fileExists(atPath: marker.path), "\(w.calls)")
    }
    do {
        // A pid used again by another launch of the person's app: never moved or resized for the old one.
        let (w, _, marker) = world()
        let p = w.start("com.apple.mobilephone", policy: .regular, windows: 1)
        var m = HostMarker(pid: 1, marginSpace: FakeHostWorld.marginSpace)
        m.windows = [HostMarker.Window(number: w.apps[p]!.windows[0], pid: p, ownSafariWindow: false, privateSpace: nil, fullScreenSpace: nil, appLaunchedAt: 5, mode: .window,
                                       bundleId: "com.apple.mobilephone", personApp: true, frame: CGRect(x: 1, y: 2, width: 300, height: 300), originalSpace: FakeHostWorld.desktop, frameChanged: true)]
        _ = m.write(marker)
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        check("crash: a marker's window of another launch (its pid used again): never moved or resized", !w.calls.contains { $0.hasPrefix("move") || $0.hasPrefix("frame") || $0.hasPrefix("terminate") } && !FileManager.default.fileExists(atPath: marker.path), "\(w.calls)")
    }
    check("host marker: a window-mode window's fields written and read back", {
        var m = HostMarker(pid: 3, marginSpace: 9)
        m.windows = [HostMarker.Window(number: 5, pid: 4, ownSafariWindow: false, privateSpace: nil, fullScreenSpace: nil, mode: .window, bundleId: "b", personApp: true, frame: CGRect(x: 1, y: 2, width: 3, height: 4), originalSpace: 1, frameChanged: true, resizable: false)]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("margin-host-marker-\(UUID().uuidString)/\(HostMarker.fileName)")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return m.write(url) && HostMarker.read(url) == m
    }())
}

func hostLayoutTests() {
    let area = CGRect(x: 0, y: 33, width: 1512, height: 949)
    let p = HostPlacement(page: CGRect(x: 280, y: 41, width: 1224, height: 933), area: area, tileWidth: 260)
    let plan = HostLayout.plan(p)
    check("host layout: the page area's edges and the spacing from the placement", plan?.edges == SlotEdges(left: 0, right: 8, top: 8, bottom: 8) && plan?.spacing == 20, "\(String(describing: plan))")
    check("host layout: the same placement, the same plan, every time (nothing read from the windows)", (0..<5).allSatisfy { _ in HostLayout.plan(p)?.edges == plan?.edges && HostLayout.plan(p)?.spacing == plan?.spacing })
    let whole = HostLayout.plan(HostPlacement(page: CGRect(x: 260, y: 33, width: 1252, height: 949), area: area, tileWidth: 260))
    check("host layout: the page area the rest of the display: nothing reserved, no spacing", whole?.edges == .zero && whole?.spacing == 0, "\(String(describing: whole))")
    check("host layout: a page area under Margin's tile can't be reached", HostLayout.plan(HostPlacement(page: CGRect(x: 200, y: 41, width: 1300, height: 900), area: area, tileWidth: 260)) == nil)
    check("host layout: a page area past the display can't be reached", HostLayout.plan(HostPlacement(page: CGRect(x: 280, y: 20, width: 1224, height: 900), area: area, tileWidth: 260)) == nil)
    check("host layout: on a display left of the main one: in its coordinates", HostLayout.plan(HostPlacement(page: CGRect(x: -1652, y: 8, width: 1644, height: 1064), area: CGRect(x: -1920, y: 0, width: 1920, height: 1080), tileWidth: 260))?.spacing == 8)
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
