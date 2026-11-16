// The host engine (HostEngine.swift), part of tests.swift's run, against a stand-in for the system that plays the
// window manager as the test kit measured it on the real Mac (2026-11-15, /tmp/margin-toolbar-test/mc/mc8, mc10): a
// window put in full screen gets a Space of its own (macOS jumps there), laid out by that Space's edge reservation;
// moved into Margin's full-screen Space by the bridge it becomes a plain member there, still full screen at the frame
// it had (its own Space keeps a tile with no window until it's destroyed); moved into a private Space it's out of
// sight, still full screen; out of full screen on the current Space it's a normal window where it is. Mission Control's
// list (every full-screen Space) is kept over the stand-in's clock (`episodes`). Nothing real is launched, put in full
// screen or moved. Also the host's private calls' check (HostCalls.swift) against a fake resolver, and its wrappers
// refusing under MARGIN_APP_TESTS.
import AppKit
import Foundation

final class FakeHostWorld: HostSystem {
    struct App { var pid: pid_t; var bundle: String; var launchedAt: Double?; var policy: HostPolicy; var windows: [Int]; var refusesQuit = false; var sidebarOpen = false }
    // frame: a normal window's (none: 100,100 800×600). canFullScreen: AXFullScreen settable; resizable: AXSize settable;
    // minSize/maxSize: the app's own limits, kept when Accessibility sizes it. member: a full-screen window moved into
    // another full-screen Space (Margin's) by the bridge, at `memberFrame` (its frame then) wherever it is.
    struct Win { var pid: pid_t; var fullScreen = false; var spaces: [UInt64]; var priv: UInt64?; var frame: CGRect? = nil
                 var canFullScreen = true; var resizable = true; var minSize: CGSize? = nil; var maxSize: CGSize? = nil; var minimized = false
                 // axRole: Accessibility's role/subrole when it isn't a standard window's (the listing, which keeps standard
                 // windows and ones that can go full screen, leaves it out; found by its number).
                 var axRole: String? = nil
                 var member = false; var memberFrame: CGRect? = nil }
    static let defaultFrame = CGRect(x: 100, y: 100, width: 800, height: 600)

    static let marginSpace: UInt64 = 100, marginTile: UInt64 = 101, desktop: UInt64 = 1, marginWindow = 1
    static let display = CGRect(x: 0, y: 33, width: 1512, height: 949) // a full-screen Space's layout area

    var clock = 0.0
    var calls: [String] = []
    var fail: Set<String> = [] // launch, ax, fullScreen, exitFullScreen, moveIn, destroy, park, setCurrent, frame, close, server
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
    var tiles: [UInt64: [UInt64]] = [FakeHostWorld.marginSpace: [FakeHostWorld.marginTile]] // full-screen Spaces (what Mission Control lists) and their tiles
    var owner: [UInt64: pid_t] = [:] // a full-screen Space's app (none: Margin's, or emptied)
    var tileWindow: [UInt64: Int] = [FakeHostWorld.marginTile: FakeHostWorld.marginWindow]
    var current = FakeHostWorld.marginSpace
    var privates: Set<UInt64> = []
    var reservation: [UInt64: SlotEdges] = [:]
    var reserves: [(space: UInt64, edges: SlotEdges)] = []
    var nextId: UInt64 = 1000, nextPid: pid_t = 500, nextWindow = 50
    var jumpOnFullScreen = true
    var exitUnparks = false // out of full screen, macOS puts a parked window on a Desktop
    var launchWindows = 1
    var sidebarOpenAtLaunch = false // Safari's windows come up with its sidebar open
    var sidebarKnown = true
    var autoShow: Bool? = true
    var dropped = 0 // the display dropped to the Desktop (a showing Space destroyed)
    var destroyedWithWindows = 0 // a Space destroyed with a window still in it
    var freezes = 0, reveals = 0
    var frozen = false
    var lastArguments: [String] = []
    var listeners: [pid_t: (Int32) -> Void] = [:]
    var onAppQuit: ((pid_t) -> Void)?
    // The bridge's move lands this long after it's asked (the window's Spaces read the old ones until then).
    var moveLag = 0.01
    var noMoveIn: Set<Int> = [] // windows the bridge doesn't move into Margin's Space
    var unparkable: Set<Int> = [] // windows the bridge doesn't move into a private Space
    var landing: [Int: (spaces: [UInt64], until: Double)] = [:]
    // Mission Control: full-screen Spaces the person has of their own (never Margin's business), and every stretch of
    // time (on the clock) a full-screen Space other than Margin's and theirs was listed.
    var theirSpaces: Set<UInt64> = []
    var episodes: [Double] = []
    var extraSince: Double?
    func noteListing() {
        let extra = tiles.keys.contains { $0 != Self.marginSpace && !theirSpaces.contains($0) }
        if extra, extraSince == nil { extraSince = clock }
        if !extra, let since = extraSince { episodes.append(clock - since); extraSince = nil }
    }
    // Mission Control lists Margin's Space (and the person's own) only.
    var listsMarginOnly: Bool { Set(tiles.keys).subtracting(theirSpaces).subtracting([Self.marginSpace]).isEmpty }
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
    // Apps started hidden (LaunchServices' hide option) that stay so until unhidden: Accessibility lists none of their
    // windows while they're hidden (Dictionary, 2026-11-15); some make their window only once unhidden. Apps whose
    // windows Accessibility lists only with AXEnhancedUserInterface on.
    var launchesHidden: Set<String> = []
    var windowOnlyUnhidden: Set<String> = []
    var needsEnhanced: Set<String> = []
    var hidden: Set<pid_t> = []
    // Apps that make spare windows (Dictionary started with no Dock icon, the probe of 2026-11-15): `count` more
    // windows of the real one's size and a 500×500 one, never ordered in (in no Space, never on screen), made before the
    // real one (lower numbers: the window server's front one is a spare). Accessibility lists those of its size
    // (AXWindow/AXDialog, the real one too) while the real one is listed and the app hasn't been activated; once it has, the real one only
    // (AXWindow/AXStandardWindow). The real one is the app's main and focused window. `orderedInOnUnhide`: started
    // hidden, its real window is ordered out too until it's unhidden (then on the Desktop).
    var spares: [String: Int] = [:]
    var orderedInOnUnhide = false
    var spareOf: [Int: Int] = [:] // a spare → the real window
    var activated: Set<pid_t> = []
    func spareListed(_ n: Int) -> Bool {
        guard let real = spareOf[n], let w = wins[n], !activated.contains(w.pid), w.frame?.size == wins[real]?.frame?.size else { return false } // (the small one never)
        return onCurrent(real) && axLists(real) && !axHides(w.pid) // (as the probe saw them: the real one on the current Space)
    }
    var enhanced: [pid_t: Bool] = [:]
    var unhideRefused = false
    func axHides(_ pid: pid_t) -> Bool {
        hidden.contains(pid) || (apps[pid].map { needsEnhanced.contains($0.bundle) } == true && enhanced[pid] != true)
    }
    func isHidden(pid: pid_t) -> Bool? { apps[pid] == nil ? nil : hidden.contains(pid) }
    func unhide(pid: pid_t) -> Bool {
        calls.append("unhide \(pid)")
        guard let a = apps[pid], !unhideRefused else { return false }
        hidden.remove(pid)
        if orderedInOnUnhide { for n in a.windows where spareOf[n] == nil && wins[n]?.spaces.isEmpty == true && wins[n]?.priv == nil { wins[n]?.spaces = [Self.desktop] } }
        if windowOnlyUnhidden.contains(a.bundle), a.windows.isEmpty {
            let n = nextWindow
            nextWindow += 1
            var win = Win(pid: pid, spaces: [Self.desktop])
            win.canFullScreen = !notFullScreen.contains(a.bundle)
            wins[n] = win
            apps[pid]?.windows = [n]
        }
        return true
    }
    func enhancedUserInterface(pid: pid_t) async -> Bool? { apps[pid] == nil ? nil : enhanced[pid] ?? false }
    func setEnhancedUserInterface(pid: pid_t, _ on: Bool) async -> Bool {
        calls.append("enhanced \(pid) \(on)")
        guard apps[pid] != nil, !fail.contains("ax") else { return false }
        enhanced[pid] = on
        return true
    }
    // The window server's bounds of a window Accessibility just set: its old frame this long after (none: at once).
    var frameLag = 0.0
    var lagging: [Int: (frame: CGRect, until: Double)] = [:]
    var onSetFrame: (() async -> Void)? // (a test's: something that happens while a frame is being set)

    // Full screen as the real Mac paces it (`staged`, measured 2026-11-16, /tmp/margin-toolbar-test/fsopen/early2.swift);
    // off, the window is in its new Space at once (macOS's jump with it). On: its new Space listed (owned by its app)
    // `stageList` after the ask, the window still where it was; that Space's reservation lays it out `stageFrame` after
    // it's set (not a Safari window with its sidebar open; never with `stageNoFrame`); the window in its Space, and the
    // jump, `stageEnter` after the ask. Moved into Margin's Space before that, it's a member at the bounds it has then (the
    // display's whole size if it hadn't the reserved frame yet); its Space destroyed before the frame came: it keeps the
    // display's whole size (the order mistake the research run showed). `stageJump`: macOS makes the new Space current
    // this long after the ask while the window isn't in it yet (to check Margin's Space is kept current). `stageMember`:
    // the window server reports the window in its new Space this long after the ask, before it has the page frame and
    // before the jump (the real Mac's log of 2026-11-16: macOS adds it to that Space while laying it out; nil: only at
    // `stageEnter`).
    var staged = false
    var stageList = 0.04, stageFrame = 0.065, stageEnter = 0.6
    var stageMember: Double? = 0.05
    var stageNoFrame = false
    var stageJump: Double?
    var stageJumpTo: UInt64? // (the Space made current then: none, the new one)
    struct Pending { var space: UInt64; var tile: UInt64; var asked: Double; var listed = false; var reservedAt: Double?; var framed = false; var jumped = false }
    var pending: [Int: Pending] = [:]
    var framedSpaces: Set<UInt64> = []
    var stagedSpaces: Set<UInt64> = []
    var destroyedBeforeFrame = 0
    var movedBeforeFrame = 0
    var offMargin = 0.0 // seconds on the clock the current Space wasn't Margin's
    var framedAt: [Int: Double] = [:]
    var askedAt: [Int: Double] = [:]
    var destroyedAt: [UInt64: Double] = [:]
    var entered: Set<Int> = [] // windows macOS put in their own Space (the slow path's state)
    var membersEarly: Set<Int> = [] // windows reported in their own Space before macOS's switch (`stageMember`)
    var moveLosesFrame = 0 // the next N moves of a pending window into Margin's Space leave it at the display's whole size
    func advance() {
        for n in pending.keys.sorted() {
            guard var p = pending[n], var w = wins[n] else { pending[n] = nil; continue }
            let since = clock - p.asked + 1e-9
            if !p.listed, since >= stageList || since >= stageEnter {
                p.listed = true
                tiles[p.space] = [p.tile]
                owner[p.space] = w.pid
                tileWindow[p.tile] = n
                noteListing()
            }
            if let at = p.reservedAt, !p.framed, !stageNoFrame, apps[w.pid]?.sidebarOpen != true, clock - at + 1e-9 >= stageFrame {
                p.framed = true
                framedSpaces.insert(p.space)
                framedAt[n] = clock
            }
            if let j = stageJump, p.listed, !p.jumped, since >= j { p.jumped = true; current = stageJumpTo ?? p.space; currentSince = clock }
            if let m = stageMember, p.listed, since >= m, w.spaces != [p.space] {
                w.spaces = [p.space]
                w.priv = nil
                wins[n] = w
                membersEarly.insert(n)
            }
            if since >= stageEnter {
                w.spaces = [p.space]
                w.priv = nil
                wins[n] = w
                pending[n] = nil
                entered.insert(n)
                if jumpOnFullScreen { current = p.space; currentSince = clock }
                continue
            }
            pending[n] = p
        }
    }
    func fullScreenSpaceOwners() -> [UInt64: pid_t]? { Dictionary(uniqueKeysWithValues: tiles.keys.map { ($0, owner[$0] ?? 0) }) }

    init() { wins[Self.marginWindow] = Win(pid: 1, spaces: [Self.marginSpace]) }

    func now() -> Double { clock }
    func sleep(_ seconds: Double) async {
        if current != Self.marginSpace { offMargin += seconds }
        clock += seconds
        advance()
        for (pid, at) in uikitQuits where clock >= at { uikitQuits[pid] = nil; quitNow(pid) }
        await Task.yield()
    }

    // iPad apps (FaceTime, Phone: UIKit's), as their logs show (2026-11-15): asked to quit with a window of theirs
    // ordered in (any Space, a private one too), they make themselves a background app (LaunchServices' 561, their
    // policy prohibited) and quit only after their own 5 s watchdog; with none, at once.
    var uikit: Set<String> = ["com.apple.FaceTime", "com.apple.mobilephone"]
    var uikitQuits: [pid_t: Double] = [:]
    func isUIKitApp(pid: pid_t) -> Bool { apps[pid].map { uikit.contains($0.bundle) } ?? false }
    // Its close button pressed by Accessibility: only for a window Accessibility reads on the current Space (when
    // axCurrentOnly) and lists; the app saves its frame as it closes.
    func close(pid: pid_t, window: Int) async -> Bool {
        calls.append("close \(window)")
        guard !fail.contains("ax"), !fail.contains("close"), let w = wins[window], w.pid == pid, !axCurrentOnly || onCurrent(window), axLists(window) || axSeen.contains(window) && onCurrent(window) else { return false }
        if let bundle = apps[pid]?.bundle { saved[bundle] = w.frame ?? Self.defaultFrame; frameAtQuit[bundle] = w.frame ?? Self.defaultFrame }
        closeWindow(window)
        return true
    }

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
        let spareCount = spares[bundleId] ?? 0
        let firstSpare = nextWindow
        if spareCount > 0 { nextWindow += spareCount }
        let pid = start(bundleId, policy: .accessory, windows: windowOnlyUnhidden.contains(bundleId) ? 0 : launchWindows)
        apps[pid]?.sidebarOpen = sidebarOpenAtLaunch
        if spareCount > 0, let real = apps[pid]?.windows.first {
            let size = CGSize(width: 1292, height: 888)
            wins[real]?.frame = CGRect(origin: CGPoint(x: 110, y: 60), size: size)
            if orderedInOnUnhide { wins[real]?.spaces = [] }
            var made: [Int] = []
            for i in 0..<spareCount { made.append(firstSpare + i) }
            made.append(nextWindow) // (the small one)
            nextWindow += 1
            for n in made {
                var spare = Win(pid: pid, spaces: [])
                spare.frame = CGRect(origin: CGPoint(x: 110, y: 60), size: n == made.last ? CGSize(width: 500, height: 500) : size)
                spare.canFullScreen = false
                spare.axRole = "AXWindow/AXDialog"
                wins[n] = spare
                spareOf[n] = real
            }
            apps[pid]?.windows = [real] + made
            main[pid] = real
            focused[pid] = real
        }
        if launchesHidden.contains(bundleId) || windowOnlyUnhidden.contains(bundleId) { hidden.insert(pid) }
        return true
    }
    var frameAtQuit: [String: CGRect] = [:] // each app's window's frame as it was asked to quit
    var fullScreenAtQuit: [String: Bool] = [:] // whether its window was still in full screen as it was asked to quit
    func terminate(pid: pid_t) -> Bool {
        calls.append("terminate \(pid)")
        guard let a = apps[pid] else { return false }
        if let n = a.windows.first, let win = wins[n] { frameAtQuit[a.bundle] = win.frame ?? Self.defaultFrame; fullScreenAtQuit[a.bundle] = win.fullScreen }
        if a.refusesQuit { return true }
        if uikit.contains(a.bundle), a.windows.contains(where: { wins[$0] != nil }) {
            apps[pid]?.policy = .prohibited
            listeners[pid]?(HostCalls.promotedCode)
            uikitQuits[pid] = clock + 5.0
            return true
        }
        quitNow(pid)
        return true
    }
    func quitNow(_ pid: pid_t) {
        guard let a = apps.removeValue(forKey: pid) else { return }
        if let n = a.windows.first, let w = wins[n] { saved[a.bundle] = w.frame ?? Self.defaultFrame } // (its frame at quit)
        for n in a.windows { wins[n] = nil }
        for (space, p) in owner where p == pid { tiles[space] = nil; owner[space] = nil }
        noteListing()
        onAppQuit?(pid)
    }

    // ---- windows ----
    func windows(pid: pid_t) async -> [HostWindow]? {
        guard !fail.contains("ax"), let a = apps[pid] else { return nil }
        if axHides(pid) { return [] }
        let listed = a.windows.filter { n in
            if spareOf[n] != nil { return false } // (a dialog's subrole, can't go full screen: never in the listing)
            if spares[a.bundle] != nil, !activated.contains(pid) { return false } // (the real one a dialog too until its app's activated)
            return axLists(n) && wins[n].map { $0.axRole == nil || $0.canFullScreen } == true
        }
        axSeen.formUnion(listed)
        return listed.compactMap { n in
            wins[n].map { HostWindow(number: n, fullScreen: $0.fullScreen, canFullScreen: $0.canFullScreen, resizable: $0.resizable, minimized: $0.minimized) }
        }
    }
    func window(pid: pid_t, number: Int) async -> HostWindow? {
        lookups += 1
        guard !fail.contains("ax"), let a = apps[pid], a.windows.contains(number), spareOf[number] == nil ? axLists(number) : spareListed(number), !axHides(pid), let w = wins[number] else { return nil }
        axSeen.insert(number)
        let dialog = spares[a.bundle] != nil && !activated.contains(pid)
        return HostWindow(number: number, fullScreen: w.fullScreen, canFullScreen: w.canFullScreen, resizable: w.resizable, minimized: w.minimized, role: dialog ? "AXWindow/AXDialog" : w.axRole ?? "AXWindow/AXStandardWindow")
    }
    func frame(pid: pid_t, window: Int) async -> CGRect? {
        guard !fail.contains("ax"), let w = wins[window], w.pid == pid, !axCurrentOnly || onCurrent(window), !w.fullScreen else { return nil }
        return w.frame ?? Self.defaultFrame
    }
    // Accessibility's position and size: only a window on the current Space (when axCurrentOnly), never a full-screen
    // one, the app's own limits kept, a fixed-size window only moved; the app saves the frame it took.
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
    func activate(pid: pid_t, window: Int) async -> Bool { calls.append("activate \(pid) \(window)"); activated.insert(pid); return apps[pid] != nil }
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
            if staged {
                pending[window] = Pending(space: space, tile: tile, asked: clock)
                askedAt[window] = clock
                stagedSpaces.insert(space)
                w.fullScreen = true
                w.member = false
                w.memberFrame = nil
                wins[window] = w
                return true
            }
            tiles[space] = [tile]
            owner[space] = pid
            tileWindow[tile] = window
            w.fullScreen = true
            w.spaces = [space]
            w.priv = nil
            w.member = false
            w.memberFrame = nil
            if jumpOnFullScreen { current = space; currentSince = clock }
        } else {
            guard w.fullScreen, !fail.contains("exitFullScreen") else { return true }
            w.fullScreen = false
            if let p = pending.removeValue(forKey: window) { tiles[p.space] = nil; owner[p.space] = nil }
            if w.member {
                // (A member leaves full screen where it is: a normal window in that Space, or still parked.)
                w.member = false
                w.memberFrame = nil
                if w.priv != nil, exitUnparks { w.priv = nil; w.spaces = [Self.desktop] }
            } else {
                for (space, list) in tiles where list.contains(where: { tileWindow[$0] == window }) {
                    tiles[space] = list.filter { tileWindow[$0] != window }
                    if owner[space] == pid, tiles[space]?.isEmpty == true { tiles[space] = nil; owner[space] = nil } // macOS closes its own Space
                }
                if w.priv == nil || exitUnparks { w.priv = nil; w.spaces = [Self.desktop] }
            }
        }
        wins[window] = w
        noteListing()
        return true
    }
    func isFullScreen(pid: pid_t, window: Int) async -> Bool? {
        guard axReads(window) else { return nil }
        return wins[window].flatMap { $0.pid == pid ? $0.fullScreen : nil }
    }
    var main: [pid_t: Int] = [:] // the app's main window; none set: its last window
    var focused: [pid_t: Int] = [:] // its focused window; none set: none
    var axAppUnread = false // the app's main and focused windows don't read
    func mainWindow(pid: pid_t) async -> Int? {
        guard !axAppUnread, !axHides(pid), let n = main[pid] ?? apps[pid]?.windows.last else { return nil }
        return !axCurrentOnly || onCurrent(n) ? n : nil
    }
    func focusedWindow(pid: pid_t) async -> Int? {
        guard !axAppUnread, !axHides(pid), let n = focused[pid] else { return nil }
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
    // A full-screen window in a Space of its own: that Space's area less its reservation (Safari's with its sidebar open
    // doesn't take it); a member: the frame it had as it came in; Margin's window: the whole area.
    func bounds(window: Int) -> CGRect? {
        guard let w = wins[window] else { return nil }
        if let lag = lagging[window], clock < lag.until { return lag.frame }
        if window == Self.marginWindow { return Self.display }
        if let p = pending[window] { return p.framed ? (reservation[p.space] ?? .zero).inset(Self.display) : (w.frame ?? Self.defaultFrame) }
        if w.member, let f = w.memberFrame { return f }
        guard w.fullScreen, w.priv == nil, let space = w.spaces.first, tiles[space] != nil else { return w.frame ?? Self.defaultFrame }
        let sidebar = apps[w.pid]?.sidebarOpen == true
        return (sidebar ? .zero : (reservation[space] ?? .zero)).inset(Self.display)
    }
    func spaces(window: Int) -> [UInt64]? {
        if let l = landing[window], clock < l.until { return l.spaces }
        return wins[window].map { $0.priv != nil ? [] : $0.spaces }
    }
    func spaceType(_ space: UInt64) -> Int? { tiles[space] != nil ? 4 : (space == Self.desktop ? 0 : nil) }
    func spaceExists(_ space: UInt64) -> Bool? { tiles[space] != nil || space == Self.desktop }
    func currentSpace(onDisplayOf space: UInt64) -> UInt64? { current }
    func setCurrentSpace(_ space: UInt64) -> Bool { calls.append("current \(space)"); guard !fail.contains("setCurrent") else { return false }; current = space; currentSince = clock; return true }
    func desktop(onDisplayOf space: UInt64) -> UInt64? { Self.desktop }
    // (No owner and no window in it: an emptied Space, or Margin's after its window went.)
    func ownerlessFullScreenSpaces() -> [UInt64]? {
        tiles.keys.filter { space in owner[space] == nil && !theirSpaces.contains(space) && !wins.values.contains { $0.priv == nil && $0.spaces.contains(space) } }.sorted()
    }
    func listedFullScreenSpaces() -> [UInt64]? { tiles.keys.sorted() }
    func destroyFullScreenSpace(_ space: UInt64) -> Bool {
        calls.append("destroy \(space)")
        guard !fail.contains("destroy") else { return true }
        destroyedAt[space] = clock
        for (n, p) in pending where p.space == space {
            if !p.framed { destroyedBeforeFrame += 1 }
            // (Destroyed before its window had the page frame: full screen where it is, at the display's whole size.)
            pending[n] = nil
            wins[n]?.member = true
            wins[n]?.memberFrame = Self.display
        }
        if current == space { dropped += 1; current = Self.desktop }
        if wins.values.contains(where: { $0.priv == nil && $0.spaces.contains(space) }) { destroyedWithWindows += 1 }
        tiles[space] = nil
        owner[space] = nil
        noteListing()
        return true
    }
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool {
        calls.append("reserve \(edges.text)")
        reservation[space] = edges
        reserves.append((space, edges))
        for (n, p) in pending where p.space == space && p.reservedAt == nil { pending[n]?.reservedAt = clock }
        return true
    }
    func reserved(space: UInt64) -> SlotEdges? { reservation[space] ?? .zero }

    // ---- parking, members ----
    func createPrivateSpace() -> UInt64? { let s = nextId; nextId += 1; privates.insert(s); return s }
    func move(window: Int, to space: UInt64) -> Bool {
        calls.append("move \(window) \(space)")
        guard var w = wins[window], !(fail.contains("moveIn") && space == Self.marginSpace), !(noMoveIn.contains(window) && space == Self.marginSpace) else { return false }
        let before = spaces(window: window) ?? []
        if let p = pending[window], !privates.contains(space), tiles[space] != nil {
            // (Moved in before macOS put it in its own Space: a member here at the bounds it has now; the transition's off.)
            pending[window] = nil
            if !p.framed { movedBeforeFrame += 1 }
            let loses = moveLosesFrame > 0
            if loses { moveLosesFrame -= 1 }
            w.memberFrame = p.framed && !loses ? (reservation[p.space] ?? .zero).inset(Self.display) : Self.display
            w.member = true
            w.priv = nil
            w.spaces = [space]
            arrivedAt[window] = clock
            wins[window] = w
            if moveLag > 0 { landing[window] = (before, clock + moveLag) }
            return true
        }
        if privates.contains(space) {
            guard !fail.contains("park"), !unparkable.contains(window) else { return false }
            w.priv = space
        } else {
            // A full-screen window brought into another full-screen Space: a member there, at the frame it had.
            if w.fullScreen, !w.member, tiles[space] != nil { w.memberFrame = bounds(window: window); w.member = true }
            w.priv = nil
            w.spaces = [space]
            arrivedAt[window] = clock
        }
        wins[window] = w
        if moveLag > 0 { landing[window] = (before, clock + moveLag) }
        return true
    }
    func destroyPrivateSpace(_ space: UInt64) -> Bool { privates.remove(space) != nil }

    // ---- the freeze, outside opens ----
    func freeze() -> Bool { freezes += 1; frozen = true; return true }
    func reveal() { reveals += 1; frozen = false }
    func watchOpens(pid: pid_t, _ heard: @escaping (Int32) -> Void) -> Bool { listeners[pid] = heard; return true }
    func stopWatchingOpens(pid: pid_t) { listeners[pid] = nil }
    func openFromOutside(_ pid: pid_t) {
        listeners[pid]?(HostCalls.openRequestCode)
        apps[pid]?.policy = .regular
        listeners[pid]?(HostCalls.promotedCode)
    }

    // The hosted windows in Margin's Space now (its members and window-mode windows).
    var inMargin: [Int] { wins.keys.filter { $0 != Self.marginWindow && wins[$0]?.priv == nil && wins[$0]?.spaces == [Self.marginSpace] }.sorted() }

    // Margin's window taken out of full screen by macOS (the green button): it goes to the Desktop, its Space stays with
    // the members in it (Margin's pid its owner).
    func marginLeavesFullScreen() {
        wins[Self.marginWindow]?.spaces = [Self.desktop]
        tiles[Self.marginSpace] = []
        current = Self.desktop
    }
    // ...and back in (the stand-in keeps its Space's number).
    func marginEntersFullScreen() {
        tiles[Self.marginSpace] = [Self.marginTile]
        wins[Self.marginWindow]?.spaces = [Self.marginSpace]
        current = Self.marginSpace
        noteListing()
    }

    // A window closed by its app (a Safari copy's closeWindow): its own full-screen Space goes with it.
    func closeWindow(_ n: Int) {
        guard let w = wins.removeValue(forKey: n) else { return }
        for (space, list) in tiles where list.contains(where: { tileWindow[$0] == n }) {
            tiles[space] = list.filter { tileWindow[$0] != n }
            if owner[space] == w.pid, tiles[space]?.isEmpty == true { tiles[space] = nil; owner[space] = nil }
        }
        apps[w.pid]?.windows.removeAll { $0 == n }
        noteListing()
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
    func world() -> (FakeHostWorld, HostEngine, URL) {
        made += 1
        let w = FakeHostWorld()
        let url = folder.appendingPathComponent("\(made)/\(HostMarker.fileName)")
        let e = HostEngine(system: w, marker: url, pid: 1)
        return (w, e, url)
    }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933) // the theme's frame: a 268 pt sidebar and 8 pt margins
    let edges = SlotEdges(left: 276, right: 8, top: 8, bottom: 8) // ...as its own Space's reservation
    func placed(_ rect: CGRect) -> HostPlacement { HostPlacement(page: rect, area: FakeHostWorld.display) }
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func open(_ e: HostEngine, _ t: HostTarget, _ rect: CGRect = page) -> HostResult? {
        hostRun { await e.open(app: t, in: placed(rect), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    // Nothing left: Mission Control lists Margin's Space only, nothing ownerless, the display never dropped to the
    // Desktop, no Space destroyed with a window in it, the screen revealed.
    func clean(_ w: FakeHostWorld) -> Bool { w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && w.destroyedWithWindows == 0 && !w.frozen }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func pid(_ w: FakeHostWorld, _ bundle: String) -> pid_t { w.running(bundleId: bundle).first?.pid ?? 0 }
    func at(_ w: FakeHostWorld, _ call: String) -> Int { w.calls.firstIndex(of: call) ?? -1 }
    final class Said { var loading: [HostID?] = []; var above: [Int?] = [] }
    func watch(_ e: HostEngine) -> Said {
        let s = Said()
        e.loading = { s.loading.append($0) }
        e.keepAbove = { s.above.append($0) }
        return s
    }

    // ---- the first open: launch → window → full screen in its own Space → reserved to the page area → a member of
    // Margin's Space → its own Space destroyed → in front ----
    do {
        let (w, e, marker) = world()
        e.options.earlyFullScreen = false // (the slow path; the early one with the real Mac's pacing below, `staged`)
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let said = watch(e)
        let r = open(e, textEdit)
        let p = pid(w, "com.apple.TextEdit"), n = window(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        check("host: an app opened and shown, fitted to the page area", r == .shown(textEdit.id, placed: true), "\(String(describing: r))")
        check("host: started with no Dock icon, never showing its own title strip", w.apps[p]?.policy == .accessory && w.lastArguments == ["-NSMenuEnableMenuBarAgent", "NO"], "\(w.lastArguments)")
        check("host: its own full-screen Space reserved at the page area's four edges (Margin's never)", w.reserves.map(\.edges) == [edges] && own != FakeHostWorld.marginSpace
              && w.reservation[FakeHostWorld.marginSpace] == nil, "\(w.reserves)")
        check("host: its window a member of Margin's Space, still full screen, at the page area", w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.wins[n]?.fullScreen == true
              && w.wins[n]?.member == true && w.bounds(window: n) == page, "\(String(describing: w.wins[n]))")
        check("host: its own Space destroyed once its window left it: Mission Control lists Margin's Space only", w.tiles[own] == nil && clean(w), "\(w.tiles)")
        check("host: Margin's window its whole width (never a tile)", w.bounds(window: FakeHostWorld.marginWindow) == FakeHostWorld.display)
        let jump = at(w, "current \(FakeHostWorld.marginSpace)"), member = at(w, "move \(n) \(FakeHostWorld.marginSpace)"), destroy = at(w, "destroy \(own)")
        check("host: macOS's jump to its new Space undone, then reserved, then the move, then the destroy (Margin's Space current)",
              jump >= 0 && jump < at(w, "reserve \(edges.text)") && at(w, "reserve \(edges.text)") < member && member < destroy && w.current == FakeHostWorld.marginSpace, "\(w.calls)")
        check("host: its app in front after it's shown, Margin's window kept below its window", w.calls.last == "activate \(p) \(n)" && said.above == [n] && e.shownAbove == n, "\(w.calls.suffix(3)) \(said.above)")
        check("host: one freeze, only around the full-screen entry (revealed before the reservation)", w.freezes == 1 && w.reveals == 1, "\(w.freezes)")
        check("host: the loading animation for it from the start, done at the end", said.loading == [textEdit.id, nil], "\(said.loading)")
        check("host: Mission Control listed its own Space only during the open, a moment (on the stand-in's clock)", w.episodes.count == 1 && (w.episodes.first ?? 9) < 2, "\(w.episodes)")
        check("host: opened, then shown", events.count == 2 && { if case .opened = events[0], case .shown = events[1] { return true }; return false }(), "\(events)")
        let m = HostMarker.read(marker)
        check("host: the marker lists the app Margin started and its window, a member", m?.apps.map(\.pid) == [p] && m?.windows.map(\.number) == [n] && m?.windows.first?.member == true
              && m?.marginSpace == FakeHostWorld.marginSpace, "\(String(describing: m))")
        let launches = w.calls.filter { $0.hasPrefix("launch") }.count
        check("host: the same target again: shown, nothing launched twice", open(e, textEdit) == .shown(textEdit.id, placed: true) && w.calls.filter { $0.hasPrefix("launch") }.count == launches)
        check("host: no Accessibility move or resize of a full-screen window", !w.calls.contains { $0.hasPrefix("frame \(n)") })

        // ---- the page area changes: placed again (out of full screen, in again in a new Space of its own) ----
        let page2 = CGRect(x: 272, y: 61, width: 1220, height: 900)
        w.calls = []
        said.loading = []
        let t0 = w.clock
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        let own2 = w.reserves.last?.space ?? 0
        check("host: a new page area: placed again, at it", ok == true && w.bounds(window: n) == page2 && w.wins[n]?.member == true && w.spaces(window: n) == [FakeHostWorld.marginSpace], "\(String(describing: w.bounds(window: n)))")
        check("host: … out of full screen on the current Space first, then full screen in a new Space of its own, reserved anew, destroyed",
              at(w, "fullScreen false \(n)") >= 0 && at(w, "fullScreen false \(n)") < at(w, "fullScreen true \(n)") && own2 != own && w.reserves.last?.edges == SlotEdges(left: 272, right: 20, top: 28, bottom: 21)
              && w.tiles[own2] == nil && clean(w), "\(w.calls) \(w.reserves)")
        check("host: … with the loading animation, its exit and entry under one freeze", said.loading == [textEdit.id, nil] && w.freezes == 2 && w.reveals == 2, "\(said.loading) \(w.freezes)")
        check("host: … the same page area again: nothing done", hostRun { await e.pageRectChanged(placed(page2)) } == true && w.calls.filter { $0.hasPrefix("fullScreen") }.count == 2)
        _ = t0

        // ---- outside open, promotion ----
        w.openFromOutside(p)
        check("host: an open from outside heard, and the promotion to a Dock app", events.contains(.outsideOpen(textEdit.id)) && events.contains(.promoted(textEdit.id)) && e.hosts[textEdit.id] != nil)
        e.poll()
        check("host: promoted once (the policy's read doesn't say it again)", events.filter { $0 == .promoted(textEdit.id) }.count == 1)

        // ---- close: out of full screen on the current Space, then quit ----
        w.calls = []
        hostRun { await e.close(textEdit.id) }
        check("host: closing the one shown: out of full screen (on the current Space) first, then quit", at(w, "fullScreen false \(n)") >= 0 && at(w, "fullScreen false \(n)") < at(w, "terminate \(p)")
              && w.fullScreenAtQuit["com.apple.TextEdit"] == false && w.apps[p] == nil, "\(w.calls)")
        check("host: closed: nothing left, the marker gone, Margin's window kept below nothing", clean(w) && !FileManager.default.fileExists(atPath: marker.path) && e.hosts.isEmpty && e.shown == nil && said.above.last == .some(nil))
    }

    // ---- refused before anything is touched ----
    do {
        let (w, e, _) = world()
        let r = hostRun { await e.open(app: textEdit, in: placed(page), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.desktop) }
        check("host: Margin's window not in a full-screen Space: refused, nothing started", { if case .failed(.margin, _)? = r { return true }; return false }() && w.apps.isEmpty)
    }

    // ---- the early full screen (the real Mac's pacing, `staged`): its new Space reserved as soon as it's listed, the
    // window moved in and that Space destroyed once it has the page frame, before macOS's Space switch: no freeze ----
    do {
        let (w, e, marker) = world()
        w.staged = true
        let said = watch(e)
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let n = window(w, "com.apple.TextEdit"), p = pid(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        let asked = w.askedAt[n] ?? -1, framed = w.framedAt[n] ?? -1, destroyed = w.destroyedAt[own] ?? -1
        check("early: shown, a member of Margin's Space at the page area, still full screen", r == .shown(textEdit.id, placed: true) && w.spaces(window: n) == [FakeHostWorld.marginSpace]
              && w.wins[n]?.member == true && w.wins[n]?.fullScreen == true && w.bounds(window: n) == page, "\(String(describing: r)) \(String(describing: w.wins[n])) \(w.calls)")
        check("early: its Space reserved while listed, its window reported in it before it had the page frame and waited past (never macOS's switch)",
              w.reserves.map(\.edges) == [edges] && w.stagedSpaces.contains(own) && w.membersEarly.contains(n) && !w.entered.contains(n), "\(w.reserves) \(w.membersEarly) \(w.entered)")
        let reserve = at(w, "reserve \(edges.text)"), move = at(w, "move \(n) \(FakeHostWorld.marginSpace)"), destroy = at(w, "destroy \(own)")
        check("early: reserved, then (the page frame) moved in, then its Space destroyed: never destroyed or moved before the frame",
              reserve >= 0 && reserve < move && move < destroy && w.destroyedBeforeFrame == 0 && w.movedBeforeFrame == 0 && framed >= 0 && framed <= destroyed, "\(w.calls)")
        check("early: no freeze, the screen never left Margin's Space", w.freezes == 0 && w.reveals == 0 && w.offMargin == 0 && w.current == FakeHostWorld.marginSpace, "\(w.freezes) \(w.offMargin)")
        check("early: in place about 0.1 s after the ask (\(Int((destroyed - asked) * 1000)) ms on the stand-in's clock; the slow path waited for macOS's 0.6 s switch)",
              asked >= 0 && destroyed - asked >= 0.1 && destroyed - asked < 0.2, "\(asked) \(framed) \(destroyed)")
        check("early: Mission Control listed its Space only that moment; nothing left", w.episodes.count == 1 && (w.episodes.first ?? 9) < 0.2 && clean(w), "\(w.episodes)")
        check("early: its app in front, Margin's window kept below it, the loading bar for it", w.calls.last == "activate \(p) \(n)" && said.above == [n] && said.loading == [textEdit.id, nil])
        check("early: the log says the early path and each step's ms", lines.contains { $0.contains("full screen by the early path") && $0.contains("listed") && $0.contains("in its Space") && $0.contains("page-sized") && $0.contains("in place, its Space gone") }
              && lines.contains { $0.contains("early (listed") }, "\(lines.filter { $0.contains("early") })")
        check("early: the marker lists it as a member, no Space of its own", HostMarker.read(marker)?.windows.first?.member == true && HostMarker.read(marker)?.windows.first?.fullScreenSpace == nil)
        check("early: a switch back and forth after it still instant", { _ = open(e, notes); let t = w.clock; _ = hostRun { await e.show(textEdit.id) }; return w.clock - t < 0.1 && w.inMargin == [n] && clean(w) }())
        check("early: the second app early too, no freeze at all", w.freezes == 0 && w.entered.isEmpty, "\(w.freezes) \(w.entered)")

        // ---- placed again (the page area moved): its exit seen (under the freeze), its entry early under the same freeze ----
        let page2 = CGRect(x: 272, y: 61, width: 1220, height: 900)
        w.calls = []
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        check("early: placed again at a new page area, through the early path, one freeze for its exit", ok == true && w.bounds(window: n) == page2 && w.wins[n]?.member == true
              && w.freezes == 1 && w.reveals == 1 && w.entered.isEmpty && w.destroyedBeforeFrame == 0 && clean(w), "\(w.calls) \(w.freezes)")
        hostRun { await e.quitAll() }
        check("early: quit: nothing left", w.apps.isEmpty && clean(w) && w.privates.isEmpty)
    }
    do {
        // macOS makes the new Space current early (the window not in it yet): Margin's Space made current again at once.
        let (w, e, _) = world()
        w.staged = true
        w.stageJump = 0.05
        let r = open(e, textEdit)
        let n = window(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        check("early: the new Space made current by macOS: Margin's current again at once (\(Int(w.offMargin * 1000)) ms off it), still early, no freeze",
              r == .shown(textEdit.id, placed: true) && w.offMargin <= 0.0051 && w.calls.contains("current \(FakeHostWorld.marginSpace)") && w.freezes == 0 && w.bounds(window: n) == page
              && w.tiles[own] == nil && w.dropped == 0 && clean(w), "\(w.offMargin) \(w.calls)")
    }
    do {
        // A Space the person went to themselves meanwhile (listed before the ask) is left alone.
        let (w, e, _) = world()
        w.staged = true
        let theirs: UInt64 = 900
        w.tiles[theirs] = [901]
        w.theirSpaces = [theirs]
        w.stageJump = 0.05
        w.stageJumpTo = theirs
        let r = open(e, textEdit)
        check("early: a Space the person went to meanwhile left current, never undone; still early", r == .shown(textEdit.id, placed: true) && w.current == theirs
              && !w.calls.contains("current \(FakeHostWorld.marginSpace)") && w.freezes == 0 && w.dropped == 0, "\(w.calls)")
    }
    do {
        // Fallback: no new Space listed within the cap: the slow path, under the freeze, from the same ask.
        let (w, e, _) = world()
        w.staged = true
        w.stageList = 2.0
        w.stageEnter = 2.1
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let n = window(w, "com.apple.TextEdit")
        check("early fallback: no new Space within 1.5 s: the slow path, under one freeze, shown at the page area, asked once",
              r == .shown(textEdit.id, placed: true) && w.freezes == 1 && w.reveals == 1 && (w.entered.contains(n) || w.membersEarly.contains(n)) && w.bounds(window: n) == page && w.wins[n]?.member == true
              && w.calls.filter { $0 == "fullScreen true \(n)" }.count == 1 && clean(w), "\(String(describing: r)) \(w.calls)")
        check("early fallback: said, with the time", lines.contains { $0.contains("the early full screen fell back after 15") && $0.contains("no new full-screen Space listed") }, "\(lines.filter { $0.contains("early") })")
    }
    do {
        // The real Mac's log (2026-11-16): the window reported in its own Space at ~0.5 s, macOS's switch to that Space
        // at 0.6 s, the page frame only after it: waited past, the switch undone at once, still early, no freeze.
        let (w, e, _) = world()
        w.staged = true
        w.stageMember = 0.5
        w.stageJump = 0.6
        w.stageFrame = 0.7
        w.stageEnter = 2.0
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let n = window(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        check("early: in its own Space and macOS's switch to it before the page frame: Margin's Space current again at once (\(Int(w.offMargin * 1000)) ms off it), still early, no freeze",
              r == .shown(textEdit.id, placed: true) && w.membersEarly.contains(n) && w.freezes == 0 && w.offMargin <= 0.0051 && w.bounds(window: n) == page && w.wins[n]?.member == true
              && w.destroyedBeforeFrame == 0 && w.movedBeforeFrame == 0 && w.tiles[own] == nil && w.current == FakeHostWorld.marginSpace && clean(w), "\(w.offMargin) \(w.calls)")
        check("early: never said as a fallback", !lines.contains { $0.contains("fell back") } && lines.contains { $0.contains("full screen by the early path") }, "\(lines.filter { $0.contains("early") })")
    }
    do {
        // Fallback: listed and reserved, in its own Space, but the window doesn't take the page frame within 1 s of the
        // reservation (macOS puts it in its Space only later): the slow path under the freeze takes it from its own Space.
        let (w, e, _) = world()
        w.staged = true
        w.stageNoFrame = true
        w.stageEnter = 1.3
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let n = window(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        check("early fallback: no page frame within 1 s: its Space never destroyed early, the slow path under the freeze takes it from its own Space",
              r == .shown(textEdit.id, placed: true) && w.destroyedBeforeFrame == 0 && w.movedBeforeFrame == 0 && w.entered.contains(n) && w.freezes == 1 && w.reveals == 1
              && w.bounds(window: n) == page && w.tiles[own] == nil && clean(w), "\(w.calls)")
        check("early fallback: said as no page frame, after about 1 s, with where the window was", lines.contains { $0.contains("the early full screen fell back after 10") && $0.contains("didn't take the page area") && $0.contains("in its Space") },
              "\(lines.filter { $0.contains("early") })")
    }
    do {
        // Fallback: moved in and destroyed, but not at the page area (the check fails): backed out under the freeze and
        // asked again, the slow path.
        let (w, e, _) = world()
        w.staged = true
        w.moveLosesFrame = 1
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let n = window(w, "com.apple.TextEdit")
        let off = at(w, "fullScreen false \(n)"), again = w.calls.lastIndex(of: "fullScreen true \(n)") ?? -1
        check("early fallback: not in place after the move: out of full screen, asked again, then shown at the page area under one freeze",
              r == .shown(textEdit.id, placed: true) && off >= 0 && off < again && w.bounds(window: n) == page && w.wins[n]?.member == true && w.freezes == 1 && w.reveals == 1 && clean(w),
              "\(String(describing: r)) \(w.calls)")
        check("early fallback: said as not in place", lines.contains { $0.contains("not in place after its move and destroy") }, "\(lines.filter { $0.contains("early") })")
    }
    do {
        // Fallback: the bridge refuses the move in: no destroy before it, the slow path (whose move is refused too) gives up cleanly.
        let (w, e, _) = world()
        w.staged = true
        w.fail = ["moveIn"]
        let r = open(e, textEdit)
        check("early fallback: the move in refused: its Space never destroyed while the window wasn't in Margin's, nothing left, the app quit",
              { if case .failed(.member, _)? = r { return true }; return false }() && w.destroyedBeforeFrame == 0 && w.apps.isEmpty && clean(w) && w.privates.isEmpty,
              "\(String(describing: r)) \(w.tiles) \(w.calls)")
    }
    do {
        // Safari's window Margin's copy made: full screen asked through its copy, the early path the same (no freeze);
        // with its sidebar open it can't take the page frame: the slow path hides it.
        for open_ in [false, true] {
            let (w, e, _) = world()
            w.staged = true
            let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
            w.apps[safariPid]?.sidebarOpen = open_
            w.axCurrentOnly = true
            let copy = FakeSafariCopy(w) { safariPid }
            copy.wire(e)
            let target = HostTarget.safariWindow(nil)
            let r = open(e, target)
            let mine = e.hosts[target.id]?.window ?? 0
            check("early: Safari's window \(open_ ? "with its sidebar open: the slow path, its sidebar hidden, under the freeze" : "early through its copy, no freeze")",
                  r == .shown(target.id, placed: true) && copy.fullScreens == ["7914 on"] && w.bounds(window: mine) == page && w.wins[mine]?.member == true
                  && w.apps[safariPid]?.sidebarOpen == false && (open_ ? w.freezes >= 1 && w.entered.contains(mine) : w.freezes == 0 && !w.entered.contains(mine))
                  && w.destroyedBeforeFrame == 0 && clean(w), "\(String(describing: r)) \(w.freezes) \(w.calls)")
        }
    }

    // ---- a failure at each step falls back, leaving nothing ----
    for (what, step) in [("launch", HostStep.launch), ("ax", .window), ("moveIn", .member)] {
        let (w, e, marker) = world()
        w.fail = [what]
        let r = open(e, textEdit)
        let ok: Bool = { if case .failed(step, _)? = r { return true }; return false }()
        check("host: \(what) fails: \(step.rawValue) failed", ok, "\(String(describing: r))")
        check("host: \(what) fails: the app Margin started quit again, out of full screen first, nothing left", w.apps.isEmpty && clean(w) && w.privates.isEmpty && e.hosts.isEmpty && e.launched.isEmpty,
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
        let own = w.reserves.first?.space ?? 0
        check("host: the destroy doesn't take: still shown, its own Space kept to try again, in the marker", r == .shown(textEdit.id, placed: true) && e.leftSpaces == [own]
              && events.contains { if case .failed(_, .destroy, _) = $0 { return true }; return false } && HostMarker.read(marker)?.leftSpaces == [own])
        check("host: … and Mission Control still listing it is said", events.contains(.listed([own])) && !w.listsMarginOnly, "\(events)")
        w.fail = []
        e.poll()
        _ = hostRun { await e.pageRectChanged(placed(page)) } // the next operation, after the poll's retry
        check("host: its own Space destroyed on a later poll", clean(w) && e.leftSpaces.isEmpty, "\(w.tiles)")
    }
    do {
        // A page area its own Space can't reach (it passes the display's area): never a full-screen window over
        // Margin's sidebar: backed out, shown in window mode (placed by Accessibility) instead.
        let (w, e, _) = world()
        let r = open(e, textEdit, CGRect(x: 276, y: 20, width: 1228, height: 940))
        let n = window(w, "com.apple.TextEdit")
        check("host: a page area its own Space can't reach: backed out of full screen, shown in window mode", r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .window
              && w.wins[n]?.fullScreen == false && w.reserves.isEmpty && clean(w), "\(String(describing: r)) \(w.calls)")
    }

    // ---- switching between opened apps: instant, no full-screen exit or entry ----
    do {
        let (w, e, _) = world()
        let said = watch(e)
        _ = open(e, textEdit)
        let aw = window(w, "com.apple.TextEdit")
        w.calls = []
        said.loading = []
        let r = open(e, notes)
        let b = pid(w, "com.apple.Notes"), bw = window(w, "com.apple.Notes")
        check("host: a second app shown, a member at the page area", r == .shown(notes.id, placed: true) && e.shown == notes.id && w.bounds(window: bw) == page && w.wins[bw]?.member == true)
        check("host: the first parked before it opened (the loading animation seen): in a private Space, still full screen, never out of it",
              w.wins[aw]?.priv != nil && w.wins[aw]?.fullScreen == true && e.hosts[textEdit.id]?.phase == .parked && !w.calls.contains("fullScreen false \(aw)")
              && at(w, "move \(aw) \(w.wins[aw]?.priv ?? 0)") < at(w, "launch com.apple.Notes"), "\(w.calls)")
        check("host: … the loading animation for the second", said.loading == [notes.id, nil], "\(said.loading)")
        check("host: Margin's Space has the second app's window only; Mission Control Margin's Space only", w.inMargin == [bw] && clean(w), "\(w.inMargin)")
        // the fast path
        w.calls = []
        said.loading = []
        let freezes = w.freezes
        let t0 = w.clock
        let back = hostRun { await e.show(textEdit.id) }
        let took = w.clock - t0
        check("host: switched back: the first shown, at the page area; the second parked, still full screen", back == .shown(textEdit.id, placed: true) && w.inMargin == [aw]
              && w.bounds(window: aw) == page && w.wins[bw]?.priv != nil && w.wins[bw]?.fullScreen == true && e.hosts[notes.id]?.phase == .parked, "\(String(describing: back))")
        check("host: the switch: well under 100 ms (\(Int(took * 1000)) ms on the stand-in's clock, a move each way), no freeze, no full-screen exit or entry, no loading animation",
              took < 0.1 && w.freezes == freezes && !w.calls.contains { $0.hasPrefix("fullScreen") || $0.hasPrefix("reserve") } && said.loading.isEmpty, "\(took) \(w.calls)")
        check("host: the new one in before the old one out (Margin's page area never seen between), then its app in front",
              at(w, "move \(aw) \(FakeHostWorld.marginSpace)") < (w.calls.firstIndex { $0.hasPrefix("move \(bw) ") } ?? -1) && w.calls.last == "activate \(pid(w, "com.apple.TextEdit")) \(aw)", "\(w.calls)")
        check("host: its private Space given back once shown; one left (the second's)", w.privates.count == 1 && w.privates.first == w.wins[bw]?.priv && clean(w))
        var times: [Double] = []
        for i in 0..<6 {
            let t = w.clock
            _ = hostRun { await e.show(i % 2 == 0 ? notes.id : textEdit.id) }
            times.append(w.clock - t)
        }
        check("host: six switches more, each well under 100 ms, Mission Control Margin's Space only throughout", times.allSatisfy { $0 < 0.1 } && clean(w) && w.episodes.count == 2, "\(times) \(w.episodes)")

        // ---- quit: every member out of full screen on the current Space, then quit ----
        w.calls = []
        hostRun { await e.quitAll() }
        check("host: quit: the parked one brought to the current Space, out of full screen there, then quit; the shown one too",
              at(w, "move \(bw) \(FakeHostWorld.marginSpace)") >= 0 && at(w, "move \(bw) \(FakeHostWorld.marginSpace)") < at(w, "fullScreen false \(bw)") && at(w, "fullScreen false \(bw)") < at(w, "terminate \(b)")
              && w.fullScreenAtQuit["com.apple.Notes"] == false && w.fullScreenAtQuit["com.apple.TextEdit"] == false, "\(w.calls)")
        check("host: quit: both apps quit, no private Space, nothing left", w.apps.isEmpty && w.privates.isEmpty && clean(w) && !e.hasHosts && w.freezes == w.reveals)
    }
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let aw = window(w, "com.apple.TextEdit")
        w.fail = ["park"]
        let r = open(e, notes)
        check("host: the first can't be parked: the second isn't started, the first still shown", { if case .failed(.park, _)? = r { return true }; return false }()
              && e.shown == textEdit.id && w.spaces(window: aw) == [FakeHostWorld.marginSpace] && w.running(bundleId: "com.apple.Notes").isEmpty && clean(w), "\(String(describing: r))")
        w.fail = []
        _ = open(e, notes)
        w.unparkable = [window(w, "com.apple.Notes")]
        let s = hostRun { await e.show(textEdit.id) }
        check("host: a switch whose shown one can't be parked: failed, that one still shown alone, the other back out of sight",
              { if case .failed(.park, _)? = s { return true }; return false }() && e.shown == notes.id && w.inMargin == [window(w, "com.apple.Notes")] && w.wins[aw]?.priv != nil && clean(w), "\(String(describing: s)) \(w.inMargin)")
        w.unparkable = []
    }
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let aw = window(w, "com.apple.TextEdit")
        w.noMoveIn = [w.nextWindow] // (the second's window)
        let r = open(e, notes)
        check("host: the second's window doesn't come into Margin's Space: failed, nothing of it left", { if case .failed(.member, _)? = r { return true }; return false }() && w.running(bundleId: "com.apple.Notes").isEmpty)
        w.noMoveIn = []
        check("host: … and the first, parked meanwhile, shown again", e.shown == textEdit.id && w.spaces(window: aw) == [FakeHostWorld.marginSpace] && clean(w), "\(String(describing: e.shown))")
    }
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let p = pid(w, "com.apple.TextEdit")
        w.apps[p]?.refusesQuit = true
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        hostRun { await e.close(textEdit.id) }
        check("host: an app that doesn't quit (asking about its work): said, left running, out of full screen", w.apps[p] != nil && w.wins[w.apps[p]!.windows[0]]?.fullScreen == false
              && events.contains { if case .failed(_, .quit, _) = $0 { return true }; return false } && clean(w))
    }

    // ---- the page area changing while one is parked: placed again lazily, when it's next shown ----
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let aw = window(w, "com.apple.TextEdit"), bw = window(w, "com.apple.Notes")
        let page2 = CGRect(x: 316, y: 41, width: 1188, height: 933)
        w.calls = []
        _ = hostRun { await e.pageRectChanged(placed(page2)) }
        check("host: the page area moved: the shown one placed again at once; the parked one left as it is", w.bounds(window: bw) == page2 && w.bounds(window: aw) == page
              && !w.calls.contains { $0.hasPrefix("fullScreen") && $0.hasSuffix(" \(aw)") }, "\(w.calls)")
        w.calls = []
        let r = hostRun { await e.show(textEdit.id) }
        check("host: the parked one shown: placed again then (out of full screen, in, reserved), at the new page area", r == .shown(textEdit.id, placed: true) && w.bounds(window: aw) == page2
              && at(w, "fullScreen false \(aw)") >= 0 && at(w, "fullScreen true \(aw)") > at(w, "fullScreen false \(aw)") && w.wins[bw]?.priv != nil && clean(w), "\(w.calls)")
        w.calls = []
        let t0 = w.clock
        _ = hostRun { await e.show(notes.id) }
        check("host: … and the switches after it instant again", w.clock - t0 < 0.1 && !w.calls.contains { $0.hasPrefix("fullScreen") } && w.bounds(window: bw) == page2)
        hostRun { await e.quitAll() }
        check("host: … quit: nothing left", w.apps.isEmpty && clean(w) && w.privates.isEmpty)
    }

    // ---- quit by the person, a window closed ----
    do {
        let (w, e, marker) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, textEdit)
        w.quitNow(pid(w, "com.apple.TextEdit"))
        check("host: the app quit by the person: said, forgotten, the marker gone", events.contains(.quitByUser(textEdit.id)) && e.hosts.isEmpty && e.shown == nil && !FileManager.default.fileExists(atPath: marker.path))
        _ = open(e, notes)
        let n = window(w, "com.apple.Notes")
        w.wins[n] = nil
        e.poll()
        check("host: its window's bounds unread once: kept (a read can miss mid-transition)", e.hosts[notes.id] != nil && !events.contains(.windowClosed(notes.id)))
        e.poll()
        check("host: its window closed: said, forgotten", events.contains(.windowClosed(notes.id)) && e.hosts.isEmpty)
    }

    // ---- the crash marker, read at the next launch: a member shown and one parked ----
    do {
        let (w, e, marker) = world()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let a = pid(w, "com.apple.TextEdit"), b = pid(w, "com.apple.Notes")
        let aw = window(w, "com.apple.TextEdit"), bw = window(w, "com.apple.Notes")
        let other = w.start("com.apple.Safari", policy: .regular, windows: 1) // not Margin's: never touched
        // Margin crashes (no quit): its window gone, its Space left with Notes in it; the next one reads the marker.
        w.onAppQuit = nil
        w.wins[FakeHostWorld.marginWindow] = nil
        w.calls = []
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        check("recovery: the parked member brought to the current Space and out of full screen there before it's quit, the shown one too",
              at(w, "move \(aw) \(FakeHostWorld.marginSpace)") >= 0 && at(w, "move \(aw) \(FakeHostWorld.marginSpace)") < at(w, "fullScreen false \(aw)") && at(w, "fullScreen false \(aw)") < at(w, "terminate \(a)")
              && at(w, "fullScreen false \(bw)") >= 0 && at(w, "fullScreen false \(bw)") < at(w, "terminate \(b)") && w.fullScreenAtQuit["com.apple.TextEdit"] == false && w.fullScreenAtQuit["com.apple.Notes"] == false, "\(w.calls)")
        check("recovery: both apps quit, their private Spaces given back, Margin's old Space destroyed, the marker gone", w.apps[a] == nil && w.apps[b] == nil && w.privates.isEmpty
              && w.tiles[FakeHostWorld.marginSpace] == nil && w.dropped == 0 && w.destroyedWithWindows == 0 && !FileManager.default.fileExists(atPath: marker.path), "\(w.tiles) \(w.calls)")
        check("recovery: an app Margin didn't start is left alone", w.apps[other] != nil && !w.calls.contains("terminate \(other)"))
    }
    do {
        let (w, _, marker) = world()
        let p = w.start("com.apple.TextEdit", policy: .regular, windows: 1)
        var m = HostMarker(pid: 1, marginSpace: nil)
        m.apps = [HostMarker.App(pid: p, bundleId: "com.apple.TextEdit", launchedAt: 5)] // launched at another time: its pid used again
        _ = m.write(marker)
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        check("recovery: a pid used again by another launch isn't quit", w.apps[p] != nil && !w.calls.contains("terminate \(p)"))
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
        check("recovery: a hosted window's own Space it left destroyed", w.tiles[space] == nil && w.dropped == 0)
    }

    // ---- Safari ----
    do {
        let (w, e, _) = world()
        let safari = HostTarget.safariWindow(nil)
        let r = open(e, safari)
        let started = pid(w, "com.apple.Safari")
        check("host: Safari not running: started with no Dock icon and its full-screen toolbar hidden, a member at the page area", r == .shown(safari.id, placed: true)
              && w.lastArguments == ["-NSMenuEnableMenuBarAgent", "NO", "-AutoShowToolbarInFullScreen", "YES"] && w.apps[started]?.policy == .accessory && clean(w), "\(String(describing: r))")
        hostRun { await e.quitAll() }
        check("host: Safari Margin started: quit at quit", w.apps[started] == nil && clean(w))
    }
    do {
        let (w, e, _) = world()
        w.sidebarOpenAtLaunch = true
        let r = open(e, .safariWindow(nil))
        let p = pid(w, "com.apple.Safari")
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
        check("host: put in full screen by its copy (setWindowState), never through Accessibility; a member at the page area", copy.fullScreens == ["7914 on"] && !w.calls.contains("fullScreen true \(mine)")
              && w.wins[mine]?.member == true && w.bounds(window: mine) == page && clean(w), "\(copy.fullScreens) \(w.calls)")
        check("host: Safari already open: never restarted, its windows untouched", !w.calls.contains { $0.hasPrefix("launch") || $0.hasPrefix("terminate") } && theirs.allSatisfy { w.wins[$0]?.fullScreen == false && w.spaces(window: $0) == [FakeHostWorld.desktop] })
        let own = w.reserves.first?.space ?? 0
        check("host: Safari's main window unread from Margin's Space: read with its own Space current a moment (under the freeze), its sidebar hidden, Margin's Space current again",
              w.apps[safariPid]?.sidebarOpen == false && w.calls.filter { $0.hasPrefix("sidebar") }.count == 1 && lines.contains { $0.contains("read with its own Space current a moment") }
              && at(w, "current \(own)") >= 0 && at(w, "current \(own)") < at(w, "sidebar \(safariPid)") && w.current == FakeHostWorld.marginSpace && w.freezes == 2 && w.reveals == 2, "\(w.calls)")
        check("host: Safari's AutoShowToolbarInFullScreen off: said as a known gap, its setting not changed", lines.contains { $0.contains("AutoShowToolbarInFullScreen is off") } && w.autoShow == false)
        check("host: the profile's name is never in the log", !lines.contains { $0.contains("Work") } && target.id.description.hasPrefix("safari:p"))
        let m = HostMarker.read(markerURL)
        check("host: the marker has the copy's id for the window, its profile and Safari's launch", m?.windows.first?.safariWindow == ext && m?.windows.first?.profile == "Work" && m?.windows.first?.appLaunchedAt == w.apps[safariPid]?.launchedAt, "\(String(describing: m))")

        // ---- parked (another app shown) and shown again: as it is, never out of full screen ----
        w.axCurrentOnly = false // (an app Margin starts: its window is found and put in full screen by Accessibility, as on the real Mac)
        _ = open(e, textEdit)
        check("host: Margin's Safari window parked as it is (still full screen, in a private Space), its copy never asked", copy.fullScreens == ["7914 on"] && e.hosts[target.id]?.phase == .parked
              && w.wins[mine]?.priv != nil && w.wins[mine]?.fullScreen == true, "\(copy.fullScreens)")
        let back = hostRun { await e.show(target.id) }
        check("host: shown again: an instant switch, its copy not asked again", back == .shown(target.id, placed: true) && copy.fullScreens == ["7914 on"] && w.spaces(window: mine) == [FakeHostWorld.marginSpace] && clean(w), "\(String(describing: back))")
        copy.closesOnlyNormal = true
        w.calls = []
        hostRun { await e.quitAll() }
        check("host: quit: Margin's Safari window out of full screen and closed by its copy, Safari left running", copy.closed == [ext] && w.wins[mine] == nil && w.apps[safariPid] != nil && clean(w) && e.leftSafariWindows.isEmpty,
              "\(copy.closed) \(copy.closedAs) \(e.leftSafariWindows)")
        let parkAt = w.calls.firstIndex { $0.hasPrefix("move \(mine) ") && !$0.hasSuffix(" \(FakeHostWorld.desktop)") } ?? 99
        let normalAt = at(w, "copy fullScreen 7914 false"), closeAt = at(w, "copy close 7914")
        check("host: quit: the shown Safari window parked first (its exit unseen), put normal by its copy there, onto the Desktop, then closed as a normal window",
              parkAt < normalAt && normalAt < at(w, "move \(mine) \(FakeHostWorld.desktop)") && at(w, "move \(mine) \(FakeHostWorld.desktop)") < closeAt && copy.closedAs == ["normal"], "\(w.calls) \(copy.closedAs)")
    }
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        w.apps[safariPid]?.sidebarOpen = true
        w.main[safariPid] = w.apps[safariPid]!.windows[0] // the person's own window stays Safari's main one
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        let r = open(e, .safariWindow(nil))
        check("host: Margin's Safari window not Safari's main one: its View menu never pressed (it would act on the person's window); it doesn't fit: not shown, closed by its copy",
              !w.calls.contains { $0.hasPrefix("sidebar") } && { if case .failed(.place, _)? = r { return true }; return false }() && copy.closed == [7914] && clean(w), "\(String(describing: r))")
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
                         ("moveIn", .member), ("Margin started Safari, moveIn", .member)] {
        let (w, e, markerURL) = world()
        let startsSafari = what.hasPrefix("Margin started")
        var safariPid: pid_t = 0
        if !startsSafari { safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1) }
        let copy = FakeSafariCopy(w) { w.running(bundleId: "com.apple.Safari").first?.pid }
        copy.wire(e)
        w.axCurrentOnly = true
        switch what {
        case "no window": copy.makesWindow = false
        case "copy refuses full screen": copy.answersFullScreen = false
        case "full screen never comes": copy.fullScreenWorks = false
        default: w.fail = ["moveIn"]
        }
        w.calls = []
        let r = open(e, .safariWindow("Work"))
        w.fail = []
        let ok: Bool = { if case .failed(step, _)? = r { return true }; return false }()
        check("host: Safari, \(what): \(step.rawValue) failed", ok, "\(String(describing: r)) \(w.calls)")
        check("host: Safari, \(what): the window Margin asked for closed by its copy, nothing of it left", copy.closed == [7914] && !copy.isOpen(7914) && e.hosts[HostTarget.safariWindow("Work").id] == nil
              && e.leftSafariWindows.isEmpty && clean(w) && w.privates.isEmpty && w.freezes == w.reveals, "\(copy.closed) \(w.tiles) \(e.leftSafariWindows)")
        if startsSafari {
            let close = at(w, "copy close 7914"), quit = w.calls.firstIndex { $0.hasPrefix("terminate") } ?? -1
            check("host: Safari, \(what): closed by its copy before the Safari Margin started is quit", close >= 0 && close < quit && w.running(bundleId: "com.apple.Safari").isEmpty, "\(w.calls)")
            check("host: Safari, \(what): the marker gone", !FileManager.default.fileExists(atPath: markerURL.path))
        } else {
            check("host: Safari, \(what): Safari left running, the person's window untouched, the marker gone", w.apps[safariPid]?.windows.count == 1 && !FileManager.default.fileExists(atPath: markerURL.path))
        }
    }
    do {
        // The app shown can't be parked for a Safari window: nothing is asked of Safari at all, the app still shown.
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = open(e, textEdit)
        w.fail = ["park"]
        let r = open(e, .safariWindow("Work"))
        w.fail = []
        check("host: Safari, the one shown can't be parked: failed before any window was asked for, the app still shown", { if case .failed(.park, _)? = r { return true }; return false }()
              && copy.asked.isEmpty && e.shown == textEdit.id && clean(w), "\(String(describing: r))")
    }
    do {
        let (w, e, markerURL) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        copy.closes = false // its copy gone quiet
        w.fail = ["moveIn"]
        let r = open(e, .safariWindow("Work"))
        w.fail = []
        let left = e.leftSafariWindows.first
        check("host: a failed open whose close isn't confirmed: kept to close later, in the marker", { if case .failed(.member, _)? = r { return true }; return false }() && copy.isOpen(7914)
              && left?.safariWindow == 7914 && left?.profile == "Work" && left?.number == copy.windowOf[7914] && HostMarker.read(markerURL)?.leftSafariWindows == [left!], "\(String(describing: left))")
        check("host: … out of full screen and on the Desktop meanwhile, in no full-screen Space", w.wins[copy.windowOf[7914] ?? 0]?.fullScreen == false && clean(w))
        copy.closes = true
        e.poll()
        _ = hostRun { await e.pageRectChanged(placed(page)) } // the next operation, after the poll's try
        check("host: … closed by its copy on a later poll (normal first), the marker gone", !copy.isOpen(7914) && e.leftSafariWindows.isEmpty && !FileManager.default.fileExists(atPath: markerURL.path)
              && copy.fullScreens.last == "7914 off")
    }
    do {
        // Margin crashed while Margin's Safari window was shown: the next launch has it made normal and closed by its copy.
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
        later.closesOnlyNormal = true
        later.wire(next)
        hostRun { await next.recover() }
        check("recovery: Margin's Safari window kept to close (its copy not linked yet), in the marker", next.leftSafariWindows.map(\.safariWindow) == [7914] && w.apps[safariPid] != nil
              && HostMarker.read(markerURL)?.leftSafariWindows?.first?.number == mine, "\(next.leftSafariWindows)")
        later.closes = true
        next.poll()
        _ = hostRun { await next.recover() } // (the next operation, after the poll's try)
        check("recovery: made normal and closed by its copy once it links, the marker gone, Safari left running", w.wins[mine] == nil && next.leftSafariWindows.isEmpty && !FileManager.default.fileExists(atPath: markerURL.path)
              && w.apps[safariPid] != nil && later.closedAs.last == "normal", "\(next.leftSafariWindows) \(later.closedAs)")
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
        check("recovery: a Safari window of another Safari launch: forgotten, never closed", copy.closed.isEmpty && next.leftSafariWindows.isEmpty && !FileManager.default.fileExists(atPath: markerURL.path))
    }
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let r = open(e, .safariWindow(nil))
        check("host: Safari already open and no link to ask for a window: failed, Safari untouched", { if case .failed(.window, _)? = r { return true }; return false }() && w.apps[safariPid] != nil && !w.calls.contains { $0.hasPrefix("fullScreen") })
    }
    do {
        // Safari's member placed again (another page area): parked first and out of full screen through its copy there
        // (its exit unseen, no freeze for it), onto the Desktop, then full screen again by its copy.
        let (w, e, _) = world()
        e.options.earlyFullScreen = false // (the slow path's freeze for its entry)
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = open(e, .safariWindow(nil))
        let mine = copy.windowOf[7914] ?? 0
        let page2 = CGRect(x: 316, y: 41, width: 1188, height: 933)
        w.calls = []
        let freezes = w.freezes
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        check("host: Safari placed again: parked, out of full screen by its copy, to the Desktop, full screen by its copy, at the new page area",
              ok == true && w.bounds(window: mine) == page2 && copy.fullScreens == ["7914 on", "7914 off", "7914 on"] && (w.calls.firstIndex { $0.hasPrefix("move \(mine) ") } ?? 99) < at(w, "copy fullScreen 7914 false")
              && w.freezes == freezes + 1 && clean(w), "\(w.calls) \(copy.fullScreens)")
    }

    // ---- Margin's window leaving full screen: the one shown parked at once, back when Margin's back ----
    do {
        let (w, e, _) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit")
        hostRun { await e.parkShown(why: "Margin's window left full screen") }
        check("host: Margin's window leaving full screen: the one shown parked as it is (still full screen), nothing shown, said",
              e.shown == nil && e.hosts[textEdit.id]?.phase == .parked && w.wins[a]?.priv != nil && w.wins[a]?.fullScreen == true && events.last == .unshown(textEdit.id) && clean(w), "\(events)")
        let t0 = w.clock
        let back = open(e, textEdit)
        check("host: Margin in full screen again and the item shown: an instant switch back", back == .shown(textEdit.id, placed: true) && w.inMargin == [a] && w.clock - t0 < 0.1, "\(String(describing: back))")

        // macOS took Margin's window out of full screen first (no word of it before): the poll finds it out of its Space.
        w.marginLeavesFullScreen()
        e.poll()
        check("host: one read with Margin's window out of its Space: not yet (a read can miss mid-transition)", e.shown == textEdit.id)
        e.poll()
        _ = hostRun { await e.pageRectChanged(placed(page)) } // (the next operation, after the poll's)
        check("host: found so twice: parked at once (still full screen), Margin's old Space with no window of Margin's destroyed, nothing shown",
              e.shown == nil && e.hosts[textEdit.id]?.phase == .parked && w.wins[a]?.priv != nil && w.tiles[FakeHostWorld.marginSpace] == nil && w.destroyedWithWindows == 0 && events.last == .unshown(textEdit.id), "\(w.tiles) \(events.suffix(3))")
        w.marginEntersFullScreen()
        let again = open(e, textEdit)
        check("host: Margin back in full screen: shown again in its Space, instantly", again == .shown(textEdit.id, placed: true) && w.inMargin == [a] && clean(w))

        // A parked window macOS (or its app) put on a Desktop: parked again.
        _ = open(e, notes)
        w.wins[a]?.priv = nil
        w.wins[a]?.spaces = [FakeHostWorld.desktop]
        e.poll(); e.poll()
        _ = hostRun { await e.pageRectChanged(placed(page)) }
        check("host: a parked window found on a Desktop: parked again, out of sight", w.wins[a]?.priv != nil && w.spaces(window: a) == [] && e.hosts[textEdit.id]?.phase == .parked)
        hostRun { await e.quitAll() }
        check("host: … and quit as any", w.apps.isEmpty && clean(w))
    }

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
        check("host: (Safari's window parked, still full screen)", w.wins[mine]?.priv != nil && w.wins[mine]?.fullScreen == true && e.hosts[HostTarget.safariWindow(nil).id]?.phase == .parked)
        hostRun { await e.quitAll() }
        check("host: quit: a parked Safari window out of full screen by its copy in its private Space, onto the Desktop, then closed as a normal window", copy.closedAs == ["normal"] && w.wins[mine] == nil && e.leftSafariWindows.isEmpty && w.privates.isEmpty && clean(w),
              "\(copy.closedAs) \(e.leftSafariWindows)")
        check("host: quit: Safari (not Margin's) left running, the app Margin started quit", w.apps[safariPid] != nil && w.running(bundleId: "com.apple.TextEdit").isEmpty)
    }

    // ---- Mission Control over a whole session: Margin's Space only, but for a moment at each first open or placing ----
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        w.theirSpaces = [55] // (a full-screen app of the person's own)
        w.tiles[55] = [56]
        w.owner[55] = safariPid
        var slow = 0
        var checks: [Bool] = []
        func after(_ ok: Bool) { checks.append(ok && w.listsMarginOnly) }
        after(open(e, textEdit) == .shown(textEdit.id, placed: true)); slow += 1
        after(open(e, notes) == .shown(notes.id, placed: true)); slow += 1
        after(open(e, .safariWindow(nil)) == .shown(HostTarget.safariWindow(nil).id, placed: true)); slow += 1
        for id in [textEdit.id, notes.id, HostTarget.safariWindow(nil).id, textEdit.id] { after(hostRun { await e.show(id) } == .shown(id, placed: true)) }
        after(hostRun { await e.pageRectChanged(placed(CGRect(x: 300, y: 41, width: 1204, height: 933))) } == true); slow += 1
        after(hostRun { await e.show(notes.id) } == .shown(notes.id, placed: true)); slow += 1 // (placed again: lazily)
        hostRun { await e.close(notes.id) }
        after(true)
        hostRun { await e.quitAll() }
        after(true)
        check("host: Mission Control after every operation: Margin's Space (and the person's own) only", checks.allSatisfy { $0 } && w.tiles[55] != nil, "\(checks)")
        check("host: … a hosted window's own Space listed only during a first open or a placing again, each under 2 s (stand-in's clock)", w.episodes.count == slow && w.episodes.allSatisfy { $0 < 2 }, "\(w.episodes) \(slow)")
    }

    windowModeTests(world: world)

    // ---- one at a time ----
    do {
        let (w, e, _) = world()
        let both = hostRun { () async -> [HostResult] in
            let at = HostPlacement(page: page, area: FakeHostWorld.display)
            async let one = e.open(app: textEdit, in: at, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace)
            async let two = e.open(app: notes, in: at, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace)
            return await [one, two]
        }
        check("host: two opens at once run one after the other: both shown in turn, one in Margin's Space", both?.allSatisfy { if case .shown = $0 { return true }; return false } == true && w.inMargin.count == 1 && clean(w), "\(String(describing: both))")
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
    func tiled(_ rect: CGRect = page) -> HostPlacement { HostPlacement(page: rect, area: FakeHostWorld.display) }
    func windowed(_ rect: CGRect = page) -> HostPlacement { HostPlacement(page: rect, area: FakeHostWorld.display) }
    func open(_ e: HostEngine, _ t: HostTarget) -> HostResult? {
        hostRun { await e.open(app: t, in: tiled(), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func clean(_ w: FakeHostWorld) -> Bool { w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && w.destroyedWithWindows == 0 && !w.frozen }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func pid(_ w: FakeHostWorld, _ bundle: String) -> pid_t { w.running(bundleId: bundle).first?.pid ?? 0 }
    func at(_ w: FakeHostWorld, _ call: String) -> Int { w.calls.firstIndex(of: call) ?? -1 }
    func last(_ w: FakeHostWorld, _ prefix: String) -> Int { w.calls.lastIndex { $0.hasPrefix(prefix) } ?? -1 }
    func frameCall(_ n: Int, _ r: CGRect, moved: Bool = false) -> String { "frame \(n) \(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))×\(Int(r.height))\(moved ? " (moved)" : "")" }
    // The engine as the shell wires it: Margin's window kept below the window shown.
    final class Hooks { var above: [Int?] = [] }
    func wired(_ e: HostEngine) -> Hooks {
        let h = Hooks()
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
        check("window mode: nothing reserved anywhere, Margin's window its whole width", w.reserves.isEmpty && w.bounds(window: FakeHostWorld.marginWindow) == FakeHostWorld.display)
        check("window mode: Margin's window kept below it (keepAbove its number), its app in front", h.above == [n] && e.shownAbove == n && w.calls.last == "activate \(p) \(n)", "\(h.above)")
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
        check("window mode → full screen: TextEdit a member of Margin's Space, fitted", t == .shown(textEdit.id, placed: true) && w.inMargin == [tw] && w.wins[tw]?.member == true && w.bounds(window: tw) == page, "\(String(describing: t))")
        check("window mode → full screen: FaceTime's frame given back on the current Space, then parked in a private Space (no full-screen exit)",
              w.wins[n]?.frame == original && w.wins[n]?.priv != nil && at(w, frameCall(n, original)) >= 0 && at(w, frameCall(n, original)) < last(w, "move \(n) ") && !w.calls.contains("fullScreen false \(n)"), "\(w.calls)")
        check("window mode → full screen: Margin's window kept below TextEdit now; FaceTime saved its own frame", h.above.last == .some(tw) && e.shownAbove == tw && w.saved["com.apple.FaceTime"] == original, "\(h.above)")
        w.calls = []
        let back = hostRun { await e.show(faceTime.id) }
        check("full screen → window mode: FaceTime back in Margin's Space at the page area, TextEdit parked still full screen", back == .shown(faceTime.id, placed: true) && w.spaces(window: n) == [FakeHostWorld.marginSpace]
              && w.bounds(window: n) == page && w.wins[tw]?.priv != nil && w.wins[tw]?.fullScreen == true && e.hosts[textEdit.id]?.phase == .parked && clean(w), "\(String(describing: back)) \(w.calls)")
        check("full screen → window mode: Margin's window kept below FaceTime again, one private Space (TextEdit's)", w.inMargin == [n] && h.above.last == .some(n) && w.privates.count == 1)

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
        check("window mode: the Desktop made current only under a freeze (revealed after), the log says so",
              w.freezes == 2 && w.reveals == 2 && lines.contains { $0.contains("with its Desktop current it found it") }, "\(lines.filter { $0.contains("Accessibility") })")
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

    // ---- an app started hidden (Dictionary, 2026-11-15: its window read by the window server, never by Accessibility,
    // and seen on its own over Margin while the open failed and it quit) ----
    let dictionary = HostTarget.app("com.apple.Dictionary")
    func covered(_ e: HostEngine, _ w: FakeHostWorld) { e.cover = { w.calls.append("cover \($0.map(String.init) ?? "none")") } }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        covered(e, w)
        w.installed.insert("com.apple.Dictionary")
        w.launchesHidden = ["com.apple.Dictionary"]
        w.axCurrentOnly = true
        var r: HostResult?
        let lines = said { r = open(e, dictionary) }
        let p = pid(w, "com.apple.Dictionary"), n = window(w, "com.apple.Dictionary")
        let unhid = at(w, "unhide \(p)"), cover = at(w, "cover \(n)"), moveIn = at(w, "move \(n) \(FakeHostWorld.marginSpace)")
        check("hidden app: Dictionary started hidden, Accessibility listing none of its windows: unhidden before its window comes into Margin's Space, hosted full screen at the page area",
              r == .shown(dictionary.id, placed: true) && e.mode(of: dictionary.id) == .fullScreen && w.wins[n]?.member == true && w.bounds(window: n) == page
              && unhid >= 0 && cover > unhid && moveIn > cover && !w.hidden.contains(p), "\(String(describing: r)) \(w.calls.prefix(12))")
        check("hidden app: its window taken from the window server at once (no 3 s wait for Accessibility), found in Margin's Space, no Desktop made current, never activated hidden",
              !w.calls.contains("current \(FakeHostWorld.desktop)") && lines.contains { $0.contains("its app was hidden: unhidden") } && lines.contains { $0.contains("Accessibility found its window in Margin's Space") }
              && (lines.first { $0.contains("opened (pid") }.map { $0.range(of: #"window \d{1,3} \(by the window server"#, options: .regularExpression) != nil } ?? false), "\(lines.filter { $0.contains("Dictionary") })")
        check("hidden app: Margin's window over it only while it's read (covered, then kept below it once shown)", w.calls.contains("cover none") && at(w, "cover none") > moveIn, "\(w.calls.filter { $0.hasPrefix("cover") })")
        hostRun { await e.quitAll() }
        check("hidden app: quit: nothing left", w.apps[p] == nil && clean(w) && w.privates.isEmpty)
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.installed.insert("com.apple.Dictionary")
        w.windowOnlyUnhidden = ["com.apple.Dictionary"] // (no window at all until it's unhidden)
        w.axCurrentOnly = true
        let r = open(e, dictionary)
        let p = pid(w, "com.apple.Dictionary"), n = window(w, "com.apple.Dictionary")
        check("hidden app: one that makes its window only once unhidden: unhidden after a moment, its window then hosted", r == .shown(dictionary.id, placed: true) && n > 0 && w.wins[n]?.member == true && at(w, "unhide \(p)") >= 0 && w.clock < 5,
              "\(String(describing: r)) \(w.clock)")
        hostRun { await e.quitAll() }
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        w.installed.insert("com.apple.Dictionary")
        w.needsEnhanced = ["com.apple.Dictionary"] // (its windows listed only with AXEnhancedUserInterface on)
        w.axCurrentOnly = true
        var r: HostResult?
        let lines = said { r = open(e, dictionary) }
        let p = pid(w, "com.apple.Dictionary"), n = window(w, "com.apple.Dictionary")
        check("enhanced interface: windows listed only with AXEnhancedUserInterface on: asked once with it on, found, hosted",
              r == .shown(dictionary.id, placed: true) && w.wins[n]?.member == true && at(w, "enhanced \(p) true") >= 0 && lines.contains { $0.contains("AXEnhancedUserInterface was on") }, "\(String(describing: r)) \(lines.filter { $0.contains("Accessibility") })")
        check("enhanced interface: set back off once it was read, never left on, no Desktop made current", w.enhanced[p] == false && at(w, "enhanced \(p) false") > at(w, "enhanced \(p) true") && !w.calls.contains("current \(FakeHostWorld.desktop)"))
        hostRun { await e.quitAll() }
    }
    do {
        let (w, e, _) = world()
        _ = wired(e)
        covered(e, w)
        w.installed.insert("com.apple.Dictionary")
        w.launchesHidden = ["com.apple.Dictionary"]
        w.unhideRefused = true // (it stays hidden: Accessibility never lists it)
        w.axCurrentOnly = true
        let r = open(e, dictionary)
        let quit = w.calls.firstIndex { $0.hasPrefix("terminate") } ?? -1
        let n = w.calls.compactMap { c -> Int? in c.hasPrefix("move ") ? Int(c.split(separator: " ")[1]) : nil }.first ?? -1
        let lastIn = w.calls.lastIndex(of: "move \(n) \(FakeHostWorld.marginSpace)") ?? -1
        let parked = w.calls.indices.first { i in i > lastIn && i < quit && w.calls[i].hasPrefix("move \(n) ") && w.calls[i] != "move \(n) \(FakeHostWorld.desktop)" } ?? -1
        check("hidden app: never listed: not hosted; its window covered while read, out of sight in a private Space before its quit, never left over Margin",
              { if case .failed(.window, _)? = r { return true }; return false }() && quit > 0 && parked > lastIn && parked < quit && at(w, "cover none") > quit
              && w.running(bundleId: "com.apple.Dictionary").isEmpty && w.privates.isEmpty && clean(w) && e.hosts.isEmpty && w.inMargin.isEmpty, "\(String(describing: r)) \(w.calls)")
    }

    // ---- which window: an app's spares (Dictionary, the probe of 2026-11-15: three 1292×888 server windows and a 500×500
    // one, only one on screen; Accessibility lists all three as dialogs before its activation, only the real one after, as a
    // standard window, its main and focused window) ----
    do {
        func sw(_ n: Int, _ w: CGFloat, _ h: CGFloat, on: Bool, order: Int) -> ServerWindow {
            ServerWindow(number: n, pid: 9, bounds: CGRect(x: 110, y: 60, width: w, height: h), onScreen: on, order: order)
        }
        // The probe's own list, front first: 52070 500×500 off, 52069 1292×888 on, 52068 and 52067 1292×888 off.
        let server = [sw(52070, 500, 500, on: false, order: 0), sw(52069, 1292, 888, on: true, order: 1), sw(52068, 1292, 888, on: false, order: 2), sw(52067, 1292, 888, on: false, order: 3)]
        let cands = HostWindowChoice.candidates(server, pid: 9)
        let none: (Int) -> Bool = { _ in false }
        let pick = { (main: Int?, focused: Int?, standard: [Int], allowed: Bool) in
            HostWindowChoice.choose(candidates: cands, inSpace: { $0 == 52069 }, main: main, focused: focused, standard: standard, serverAllowed: allowed)
        }
        check("window choice: Accessibility's main window first (the probe: 52069), before Accessibility lists it as a standard window", pick(52069, 52069, [], false).map { $0 == (52069, .main) } == true)
        check("window choice: its focused window when the main one doesn't read", pick(nil, 52069, [], false).map { $0 == (52069, .focused) } == true)
        check("window choice: neither read: the window server's one on screen, never the front spare (52070) nor another of its size",
              pick(nil, nil, [], true).map { $0 == (52069, .onScreen) } == true, "\(String(describing: pick(nil, nil, [], true)))")
        check("window choice: an off-screen duplicate named main while the on-screen one is there: not taken", pick(52068, nil, [], true).map { $0 == (52069, .onScreen) } == true)
        check("window choice: the window server's alone not yet allowed (its window may still be coming): nothing chosen", pick(nil, nil, [], false) == nil)
        // Nothing on screen (another Space current): Accessibility's standard window among the same-size ones, else the one in a Space.
        let off = server.map { sw($0.number, $0.bounds.width, $0.bounds.height, on: false, order: $0.order) }
        let offCands = HostWindowChoice.candidates(off, pid: 9)
        check("window choice: none on screen: the one Accessibility lists as a standard window (after its activation), not the front spare",
              HostWindowChoice.choose(candidates: offCands, inSpace: none, main: nil, focused: nil, standard: [52069], serverAllowed: true).map { $0 == (52069, .standard) } == true)
        check("window choice: none on screen, none listed: the one in a Space (the spares, never ordered in, in none)",
              HostWindowChoice.choose(candidates: offCands, inSpace: { $0 == 52069 }, main: nil, focused: nil, standard: [], serverAllowed: true).map { $0 == (52069, .inSpace) } == true)
        check("window choice: nothing tells them apart: the front one, said so; one window alone: its only one",
              HostWindowChoice.choose(candidates: offCands, inSpace: none, main: nil, focused: nil, standard: [], serverAllowed: true).map { $0 == (52070, .front) } == true
              && HostWindowChoice.choose(candidates: [off[1]], inSpace: none, main: nil, focused: nil, standard: [], serverAllowed: true).map { $0 == (52069, .only) } == true)
        check("window choice: the window server's list unread: Accessibility's main window only if it lists it",
              HostWindowChoice.choose(candidates: [], inSpace: none, main: 7, focused: nil, standard: [7], serverAllowed: true).map { $0 == (7, .main) } == true
              && HostWindowChoice.choose(candidates: [], inSpace: none, main: 7, focused: nil, standard: [], serverAllowed: true) == nil)
        check("window choice: candidates are layer 0, drawn, 100×100 at least, not excluded, front first",
              HostWindowChoice.candidates(server + [ServerWindow(number: 1, pid: 9, layer: 3, bounds: CGRect(x: 0, y: 0, width: 400, height: 400)), ServerWindow(number: 2, pid: 9, bounds: CGRect(x: 0, y: 0, width: 50, height: 400)), ServerWindow(number: 3, pid: 9, bounds: CGRect(x: 0, y: 0, width: 400, height: 400), alpha: 0), ServerWindow(number: 4, pid: 8, bounds: CGRect(x: 0, y: 0, width: 400, height: 400))], pid: 9, excluded: { $0 == 52068 }).map(\.number) == [52070, 52069, 52067])
    }
    do {
        // The stand-in plays the probe: with its Desktop current, the real one on screen, all three listed as dialogs before its activation, the real one only after.
        let w = FakeHostWorld()
        w.installed.insert("com.apple.Dictionary")
        w.spares = ["com.apple.Dictionary": 2]
        w.current = FakeHostWorld.desktop
        _ = w.launchDockless(bundleId: "com.apple.Dictionary", arguments: [])
        let p = w.running(bundleId: "com.apple.Dictionary").first?.pid ?? 0, real = w.apps[p]?.windows.first ?? 0
        let all = w.apps[p]?.windows ?? []
        let server = w.serverWindows(pid: p) ?? []
        let roles = { () -> [String] in all.compactMap { n in hostRun { await w.window(pid: p, number: n) }??.role.map { "\(n) \($0)" } } }
        let before = roles().sorted()
        _ = hostRun { await w.activate(pid: p, window: real) }
        let after = roles()
        let main = hostRun { await w.mainWindow(pid: p) } ?? nil
        check("window choice: the stand-in's spares as the probe saw them: four server windows, three of one size, only the real one on screen",
              server.count == 4 && Set(server.filter { $0.bounds.size == CGSize(width: 1292, height: 888) }.map(\.number)).count == 3 && server.filter(\.onScreen).map(\.number) == [real]
              && server.min { $0.number < $1.number }?.number != real, "\(server)")
        check("window choice: Accessibility lists the three as dialogs before its activation, the real one only after, as a standard window; the real one its main window",
              before == all.filter { w.wins[$0]?.frame?.width == 1292 }.sorted().map { "\($0) AXWindow/AXDialog" } && after == ["\(real) AXWindow/AXStandardWindow"] && main == real, "\(before) → \(after)")
        let chosen = HostWindowChoice.choose(candidates: HostWindowChoice.candidates(server, pid: p), inSpace: { !(w.spaces(window: $0) ?? []).isEmpty }, main: nil, focused: nil, standard: [], serverAllowed: true)
        check("window choice: on the stand-in, main unread: the one on screen", chosen.map { $0 == (real, .onScreen) } == true, "\(String(describing: chosen))")
    }
    // The engine: Margin's Space current, Dictionary's window on its Desktop with its spares (the real log: "window 3024 (by
    // the window server: on another Space)", then never listed).
    func spared(_ setup: (FakeHostWorld) -> Void) -> (FakeHostWorld, HostEngine, HostResult?, [String]) {
        let (w, e, _) = world()
        _ = wired(e)
        w.installed.insert("com.apple.Dictionary")
        w.spares = ["com.apple.Dictionary": 2]
        setup(w)
        var r: HostResult?
        let lines = said { r = open(e, dictionary) }
        return (w, e, r, lines)
    }
    do {
        let (w, e, r, lines) = spared { _ in }
        let p = pid(w, "com.apple.Dictionary"), n = window(w, "com.apple.Dictionary")
        check("spares: Accessibility's main window read: the real one hosted at once (never a spare), full screen at the page area",
              r == .shown(dictionary.id, placed: true) && e.mode(of: dictionary.id) == .fullScreen && w.wins[n]?.member == true && w.bounds(window: n) == page
              && lines.contains { $0.contains("its window \(n) chosen as Accessibility's main window") } && w.clock < 3, "\(String(describing: r)) \(lines.filter { $0.contains("Dictionary") })")
        check("spares: no spare ever moved", !w.calls.contains { c in w.spareOf.keys.contains { c.hasPrefix("move \($0) ") } }, "\(w.calls.filter { $0.hasPrefix("move") })")
        hostRun { await e.quitAll() }
        check("spares: quit: nothing left", w.apps[p] == nil && clean(w) && w.privates.isEmpty)
    }
    do {
        let (w, e, r, lines) = spared { $0.axCurrentOnly = true } // (Accessibility reads nothing on its Desktop: no main window, no listing)
        let n = window(w, "com.apple.Dictionary")
        check("spares: nothing from Accessibility, none on screen: the window server's one in a Space (the spares in none), found in Margin's Space, hosted",
              r == .shown(dictionary.id, placed: true) && w.wins[n]?.member == true && lines.contains { $0.contains("its window \(n) chosen as the one in a Space") }
              && lines.contains { $0.contains("Accessibility found its window in Margin's Space") } && !w.calls.contains { c in w.spareOf.keys.contains { c.hasPrefix("move \($0) ") } },
              "\(String(describing: r)) \(lines.filter { $0.contains("Dictionary") })")
        hostRun { await e.quitAll() }
    }
    do {
        // Started hidden, every window ordered out until it's unhidden: nothing tells them apart at first (the front one, a
        // spare); chosen again once it's unhidden, before it's moved: the real one.
        let (w, e, r, lines) = spared { w in w.axCurrentOnly = true; w.launchesHidden = ["com.apple.Dictionary"]; w.orderedInOnUnhide = true }
        let p = pid(w, "com.apple.Dictionary"), n = window(w, "com.apple.Dictionary")
        let spare = w.spareOf.keys.min() ?? -1
        check("spares: started hidden, all ordered out: the front one taken first (a spare), said",
              lines.contains { $0.contains("its window \(spare) chosen as the window server's front one") }, "\(lines.filter { $0.contains("Dictionary") })")
        check("spares: unhidden, then chosen again before it's moved: the real one (in a Space now), hosted; no spare ever moved",
              r == .shown(dictionary.id, placed: true) && w.wins[n]?.member == true && at(w, "unhide \(p)") >= 0 && at(w, "unhide \(p)") < at(w, "move \(n) \(FakeHostWorld.marginSpace)")
              && lines.contains { $0.contains("its window chosen again before it's moved: \(n)") } && !w.calls.contains { c in w.spareOf.keys.contains { c.hasPrefix("move \($0) ") } },
              "\(String(describing: r)) \(w.calls.prefix(14)) \(lines.filter { $0.contains("Dictionary") })")
        hostRun { await e.quitAll() }
        check("spares: quit: nothing left", w.apps[p] == nil && clean(w) && w.privates.isEmpty)
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
        let te = { pid(w, "com.apple.TextEdit") }
        hostRun { await e.activateShown(at: around) }
        check("window mode: a press in the page area around it: its app given the keyboard", w.calls == ["activate \(p) \(n)"], "\(w.calls)")
        // A press while its window is given back (a switch parks it, then Margin quits): never activated.
        w.calls = []
        w.onSetFrame = { await e.activateShown(at: around) }
        _ = open(e, textEdit)
        check("window mode: parked by a switch (its frame given back): its app never activated, even with a press meanwhile (the app shown is)",
              w.wins[n]?.priv != nil && !w.calls.contains { $0.hasPrefix("activate \(p) ") } && w.calls.contains { $0.hasPrefix("activate \(te()) ") }, "\(w.calls)")
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
              && lines.contains { $0.contains("didn't quit within 6 s (still no Dock icon; 1 other window of its own on screen (it may be asking something); Accessibility still answers for it)") },
              "\(lines.filter { $0.contains("quit") })")
    }

    // ---- an iPad app (FaceTime) Margin quits: its window closed first, so its own quit doesn't wait out its 5 s
    // watchdog (2026-11-15: parked, given back to its Desktop, then asked to quit: 5 s, and its 561 read as a promotion) ----
    for path in ["parked", "shown"] {
        let (w, e, _) = world()
        _ = wired(e)
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime"), n = window(w, "com.apple.FaceTime")
        w.axCurrentOnly = true
        if path == "parked" { w.axCurrentOnly = false; _ = open(e, notes); w.axCurrentOnly = true }
        check("iPad app at quit (\(path)): FaceTime \(path) before Margin quits", path == "parked" ? w.wins[n]?.priv != nil : e.shown == faceTime.id)
        w.calls = []
        let freezes = w.freezes
        let t0 = w.clock
        let lines = said { hostRun { await e.quitAll() } }
        let took = w.clock - t0
        check("iPad app at quit (\(path)): its window closed by its close button before it was asked to quit, \(path == "parked" ? "brought to the current Space first (under the freeze), never onto its Desktop" : "where it was")",
              at(w, "close \(n)") >= 0 && at(w, "close \(n)") < at(w, "terminate \(p)") && !w.calls.contains("move \(n) \(FakeHostWorld.desktop)")
              && (path == "shown" || (at(w, "move \(n) \(FakeHostWorld.marginSpace)") >= 0 && at(w, "move \(n) \(FakeHostWorld.marginSpace)") < at(w, "close \(n)") && w.freezes > freezes)), "\(w.calls)")
        check("iPad app at quit (\(path)): quit at once (\(Int(took * 1000)) ms in all, not its 5 s watchdog), its saved frame its own, nothing left",
              took < 1 && w.apps[p] == nil && w.saved["com.apple.FaceTime"] == original && w.privates.isEmpty && clean(w)
              && lines.contains { $0.contains("its window closed before its quit") } && !lines.contains { $0.contains("didn't quit") }, "\(took) \(w.calls) \(lines.filter { $0.contains("FaceTime") })")
        check("iPad app at quit (\(path)): never taken for a Dock app", !events.contains(.promoted(faceTime.id)), "\(events)")
    }
    do {
        // Its close button not taking (a sheet, Accessibility refusing): quit with its window open, as before, and its
        // 561 (a background app now, as it quits) not taken for a promotion; out after its own watchdog.
        let (w, e, _) = world()
        _ = wired(e)
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime")
        w.fail = ["close"]
        let lines = said { hostRun { await e.quitAll() } }
        check("iPad app at quit, its close refused: asked to quit with its window open, its type change not a promotion, out by its own watchdog (seen quitting)",
              w.calls.contains("terminate \(p)") && w.apps[p] == nil && !events.contains(.promoted(faceTime.id))
              && lines.contains { $0.contains("its type changed (LaunchServices 561), now a background app, as it quits: not a Dock app") } && !lines.contains { $0.contains("didn't quit") },
              "\(events) \(lines.filter { $0.contains("FaceTime") })")
        check("iPad app at quit, its close refused: its frame still its own", w.saved["com.apple.FaceTime"] == original && w.frameAtQuit["com.apple.FaceTime"] == original)
    }
    do {
        // An AppKit app (Calculator) isn't closed first: closing its windows would change what it restores.
        let (w, e, _) = world()
        _ = wired(e)
        _ = open(e, calculator)
        let p = pid(w, "com.apple.calculator")
        hostRun { await e.quitAll() }
        check("an AppKit app at quit: asked to quit with its window open, never closed first", w.calls.contains("terminate \(p)") && !w.calls.contains { $0.hasPrefix("close ") } && w.apps[p] == nil, "\(w.calls)")
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
        check("person's app that can go full screen: read in Margin's Space, then a member there, fitted", r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .fullScreen && w.inMargin == [n] && w.wins[n]?.member == true && w.bounds(window: n) == page && h.above.last == .some(n),
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
    let p = HostPlacement(page: CGRect(x: 280, y: 41, width: 1224, height: 933), area: area)
    let plan = HostLayout.plan(p)
    check("host layout: a hosted window's own Space reserves the page area's four edges", plan == SlotEdges(left: 280, right: 8, top: 8, bottom: 8), "\(String(describing: plan))")
    check("host layout: the same placement, the same plan, every time (nothing read from the windows)", (0..<5).allSatisfy { _ in HostLayout.plan(p) == plan })
    check("host layout: the page area the whole display: nothing reserved", HostLayout.plan(HostPlacement(page: area, area: area)) == .zero)
    check("host layout: fractions taken to whole points (a fractional reservation takes a window out of full screen)", HostLayout.plan(HostPlacement(page: CGRect(x: 280.4, y: 41.6, width: 1224, height: 933), area: area)) == SlotEdges(left: 280, right: 8, top: 9, bottom: 7))
    check("host layout: a page area past the display can't be reached", HostLayout.plan(HostPlacement(page: CGRect(x: 280, y: 20, width: 1224, height: 900), area: area)) == nil)
    check("host layout: on a display left of the main one: in its coordinates", HostLayout.plan(HostPlacement(page: CGRect(x: -1652, y: 8, width: 1644, height: 1064), area: CGRect(x: -1920, y: 0, width: 1920, height: 1080))) == SlotEdges(left: 268, right: 8, top: 8, bottom: 8))
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
    check("host calls: the counts", all.functionsFound == 12 && all.functionsTotal == 12 && all.selectorsFound == 2 && all.selectorsTotal == 2, "\(all)")
    check("host calls: the launch line", all.line(build: "26B131").hasPrefix("private calls (host) on 26B131: host ok (12/12 functions and keys, 2/2 selectors, encodings ok); outside opens ok"), all.line(build: "26B131"))
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
    check("host calls: the wrappers refuse under MARGIN_APP_TESTS", wrappers.refuses && wrappers.spaceType(5) == nil
          && !wrappers.destroyFullScreenSpace(5) && !wrappers.setCurrent(5, display: "Main")
          && !wrappers.launchDockless(URL(fileURLWithPath: "/Applications/TextEdit.app"), arguments: [], done: { _ in }) && wrappers.listen(pid: 1, heard: { _ in }) == nil)
    check("host calls: the real resolver finds nothing in a test", HostCalls.evaluate(RealPrivateResolver(), base: base).host == false)
}
