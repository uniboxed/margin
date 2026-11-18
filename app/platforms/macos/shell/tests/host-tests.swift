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
                 var member = false; var memberFrame: CGRect? = nil
                 // tiled: its own tile moved into another full-screen Space (Margin's), its bounds its tile's rect less the
                 // display's top band, wherever the window is (shown, or parked in a private Space).
                 var tiled = false }
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
    // (A full-screen window's own toolbar window goes where its window goes: `toolbarAbove`.)
    var wins: [Int: Win] = [:] {
        didSet {
            for (h, t) in toolbarOf { if let w = wins[h], wins[t] != nil { wins[t]?.spaces = w.spaces; wins[t]?.priv = w.priv } }
        }
    }
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
    // The behaviour classes' stand-ins (behaviour-world.swift): told of each dockless launch, and of each step of the clock.
    var onLaunch: ((pid_t) -> Void)?
    var onClock: (() -> Void)?
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
    func onCurrent(_ window: Int) -> Bool { if let h = toolbarHost(window) { return onCurrent(h) }; return wins[window].map { $0.priv == nil && $0.spaces.contains(current) } ?? false }
    // Windows ordered out (never ordered in, or ordered out by their app): in whatever Space the bridge put them, off
    // screen, and not in Accessibility's lists (they have only windows ordered in). The behaviours' stand-ins set them.
    var orderedOut: Set<Int> = []
    // The real Mac's window mode, 2026-11-17 (the real-screen suite's noFullScreen and fixedSize, the Phone, Calculator):
    // a window that can't go full screen, not in full screen, in a full-screen Space that isn't its own (Margin's) stays
    // off screen there, its app activated and its window raised all the same. On: played so (`hiddenInFullScreen`);
    // `reopenShows`: until its app gets a Dock-icon click (one hypothesis of why: not ordered in), then shown.
    // `frontShows` (what the real Mac's logs showed, 2026-11-17 17:58: an app started hidden, its window ordered in while
    // it was hidden; the Phone's came on screen the moment its own reopen made it the front process, SetFrontProcess):
    // until its app is made the front app by Accessibility's AXFrontmost (`frontmost`); NSRunningApplication's activation
    // (`activate`) doesn't, Margin never being the active app (its UI a panel), so macOS's cooperative activation refuses it.
    var windowedHiddenInFullScreen = false
    var reopenShows = false
    var frontShows = false
    var reopenedApps: Set<pid_t> = []
    var frontedApps: Set<pid_t> = []
    var front: pid_t?
    func frontmost(pid: pid_t) async -> Bool {
        calls.append("frontmost \(pid)")
        guard apps[pid] != nil else { return false }
        frontedApps.insert(pid)
        front = pid
        if !unhideRefused { hidden.remove(pid) } // (activated, an app is unhidden: one that refuses stays hidden)
        return true
    }
    func frontApp() -> pid_t? { front }
    // How long an app takes to answer the raise (Accessibility's, at each activation: Messages 79 ms, 2026-11-17).
    var activateLag = 0.0
    func hiddenInFullScreen(_ n: Int) -> Bool {
        if let h = toolbarHost(n) { return hiddenInFullScreen(h) }
        guard windowedHiddenInFullScreen, let w = wins[n], !w.canFullScreen, !w.fullScreen, w.priv == nil, !(reopenShows && reopenedApps.contains(w.pid)),
              !(frontShows && frontedApps.contains(w.pid)) else { return false }
        return w.spaces.contains { tiles[$0] != nil && owner[$0] != w.pid }
    }
    // A Dock-icon click (kAEReopenApplication): played by the behaviours' stand-ins (BehaviourWorld.reopen); none: not sent.
    var onReopen: ((pid_t) -> Int?)?
    func reopen(pid: pid_t) -> Bool {
        calls.append("reopen \(pid)")
        guard apps[pid] != nil, let onReopen else { return false }
        reopenedApps.insert(pid)
        _ = onReopen(pid)
        return true
    }
    func axReads(_ window: Int) -> Bool { !closedWins.contains(window) && (!axCurrentOnly || onCurrent(window) || axSeen.contains(window)) }
    // Accessibility lists a window only this long after it's on the current Space (moved there, or its Space made
    // current): the window server moves it first (seen 2026-11-15: Calculator brought into Margin's Space, not listed
    // within a second). And windows it lists only while the Desktop is current (where a stand-alone test saw Calculator's).
    var axDelay = 0.0
    var arrivedAt: [Int: Double] = [:]
    var currentSince = 0.0
    var axDesktopOnly: Set<Int> = []
    var lookups = 0 // Accessibility asked for a window by its number
    func axLists(_ n: Int) -> Bool {
        guard !orderedOut.contains(n), !axCurrentOnly || onCurrent(n) else { return false }
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
    // Windows with no window-server window while their app is hidden (a hidden Safari's unfocused new window, the
    // real Mac 2026-11-16; or a restored one): ordered in `orderInAfterUnhide` after their app is unhidden.
    var madeOnUnhide: Set<Int> = []
    var restoredOnUnhide: Set<String> = [] // apps whose windows at launch (restored ones) are made only once they're unhidden
    var orderInAfterUnhide = 0.05
    var unhiddenAt: [pid_t: Double] = [:]
    var serverFrom: [Int: Double] = [:] // windows the window server lists only from then on (a new window Safari is still making)
    func serverMade(_ n: Int) -> Bool {
        if let at = serverFrom[n], clock + 1e-9 < at { return false }
        guard madeOnUnhide.contains(n) else { return true }
        guard let pid = wins[n]?.pid, !hidden.contains(pid), let at = unhiddenAt[pid] else { return false }
        return clock - at + 1e-9 >= orderInAfterUnhide
    }
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
        if hidden.remove(pid) != nil { unhiddenAt[pid] = clock }
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
    // Apps whose window comes up already in full screen, in a Space of its own (owned by the app), the app hidden: they
    // restored it so (Maps, 2026-11-17: `windowIsFullScreen=1 appIsHidden=1`, the Dock adding its Space as it launched).
    var restoredFullScreen: Set<String> = []
    var restoredSpaces: Set<UInt64> = []
    // ...or in full screen as a member of the current Space (Margin's): full screen by Accessibility, no Space of its own.
    var restoredAsMember: Set<String> = []
    // A dockless launch's windows open in the current Space (an accessory app's do on the real Mac: Margin's).
    var launchInCurrent = false
    // Apps whose full screen macOS refuses while their window is in a full-screen Space (Margin's) and takes on a
    // Desktop: the ask is taken by Accessibility, and nothing comes of it.
    var desktopOnlyFullScreen: Set<String> = []
    var refusedAsks = 0
    // macOS refuses every full-screen ask for a window that isn't on the current Space (the Dock's "not the current
    // space", 2026-11-17), and an app activated whose window is on a Desktop that isn't current makes that Desktop current.
    var currentOnlyFullScreen = false
    var activateShowsDesktop = false
    // Apps whose full-screen window isn't laid out by its Space's reservation (it keeps the display's whole area).
    var noLayout: Set<String> = []
    // Accessibility elements kept by the engine's side gone stale: every frame set through one refused
    // (kAXErrorInvalidUIElement) until the window is found again by its number while it's listed. `staleOnLeave`: an
    // app's window's element goes stale as the window leaves for a private Space (the Phone's, 2026-11-17).
    var axStale: Set<Int> = []
    var staleOnLeave: Set<String> = []
    var frameErrors: [Int: Int32] = [:]
    func frameError(window: Int) -> Int32? { frameErrors[window] }
    func refreshWindow(pid: pid_t, window: Int) async -> Bool {
        calls.append("refresh \(window)")
        guard !fail.contains("ax"), apps[pid]?.windows.contains(window) == true, axLists(window), !axHides(pid) else { return false }
        axStale.remove(window)
        axSeen.insert(window)
        return true
    }
    var onSetFrame: (() async -> Void)? // (a test's: something that happens while a frame is being set)
    // Apps that refuse every Accessibility set (full screen, frames: kAXErrorCannotComplete) for this long after their
    // launch (an app still launching: Mail, 2026-11-17), and those of them that take the first refused full-screen ask
    // anyway, `lateTake` later (Mail went full screen after Margin had given up on it).
    var axBusyFor: [String: Double] = [:]
    var axBusyUntil: [pid_t: Double] = [:]
    var takesLate: Set<String> = []
    var lateTake = 0.3
    var lateAsks: [Int: Double] = [:]
    var tookLate = 0
    func axBusy(_ pid: pid_t) -> Bool { axBusyUntil[pid].map { clock + 1e-9 < $0 } ?? false }
    // Apps whose window in full screen has its toolbar as a window of its own (a strip across the display's top, in the
    // Space that was current as it went in); `stripLingers`: it stays after the window's first exit, gone at the next ask
    // out (Mail's 69769, 2026-11-17).
    var stripOnFullScreen: Set<String> = []
    var stripLingers: Set<String> = []
    var strips: [Int: Int] = [:] // the window → its strip
    var lingered: Set<Int> = []
    static let stripFrame = CGRect(x: 0, y: 33, width: 1512, height: 88)
    func makeStrip(for window: Int) {
        guard let w = wins[window], strips[window] == nil, let bundle = apps[w.pid]?.bundle, stripOnFullScreen.contains(bundle) else { return }
        let n = nextWindow
        nextWindow += 1
        var strip = Win(pid: w.pid, spaces: [current], frame: Self.stripFrame)
        strip.canFullScreen = false
        strip.axRole = "AXWindow/AXUnknown"
        wins[n] = strip
        apps[w.pid]?.windows.append(n)
        strips[window] = n
    }
    // Apps whose full-screen window has its toolbar as a window of its own resting just above its frame (Safari with its
    // toolbar hidden in full screen, the real Mac 2026-11-17 19:17: 74772 over 74770, docs/MARGIN-APP.md "Safari's toolbar
    // band"): the frame's width, `toolbarHeight` tall, its bottom at the frame's top, in the window's Space; the window
    // server moves the two together (a move of either takes both: Margin's park of 74772 took 74770 out of Margin's Space).
    var toolbarAbove: Set<String> = []
    var toolbarOf: [Int: Int] = [:] // the window → its toolbar
    func toolbarHost(_ n: Int) -> Int? { toolbarOf.first { $0.value == n }?.key }
    static let toolbarHeight: CGFloat = 52
    func makeToolbar(for window: Int) {
        guard let w = wins[window], toolbarOf[window] == nil, let bundle = apps[w.pid]?.bundle, toolbarAbove.contains(bundle) else { return }
        let n = nextWindow
        nextWindow += 1
        var t = Win(pid: w.pid, spaces: w.spaces, priv: w.priv)
        t.canFullScreen = false
        t.axRole = "AXWindow/AXUnknown"
        toolbarOf[window] = n
        wins[n] = t
        apps[w.pid]?.windows.append(n)
    }
    func dropToolbar(of window: Int) {
        guard let n = toolbarOf.removeValue(forKey: window) else { return }
        wins[n] = nil
        for pid in apps.keys { apps[pid]?.windows.removeAll { $0 == n } }
    }
    func dropStrip(of window: Int, asked: Bool) {
        guard let n = strips[window] else { return }
        if let pid = wins[window]?.pid, let bundle = apps[pid]?.bundle, stripLingers.contains(bundle), !lingered.contains(window), !asked { lingered.insert(window); return }
        strips[window] = nil
        wins[n] = nil
        for pid in apps.keys { apps[pid]?.windows.removeAll { $0 == n } }
    }

    // Full screen as the real Mac paces it (`staged`; measured 2026-11-16, /tmp/margin-toolbar-test/fsopen/early2.swift,
    // and Margin's own logs of 2026-11-17, check10e/f); off, the window is in its new Space at once (macOS's jump with
    // it). On, macOS's own change runs to its end whatever the bridge does meanwhile:
    // - its new Space listed (owned by its app) `stageList` after the ask, the window still where it was;
    // - that Space's reservation lays the window out `stageFrame` after it's set (the real Mac: ~25 ms in some runs,
    //   only once the window is in its Space in others: `stageFrameLate` after that; not a Safari window with its sidebar
    //   open; never with `stageNoFrame`);
    // - `stageMember` after the ask (the real Mac: ~525 ms; nil: at `stageEnter`) macOS brings the window into its new
    //   Space, wherever the bridge moved it before (`rehomedLate`). That Space destroyed by then: the window is in no
    //   Space at all, and the display shows a Space that's gone: nothing of Margin's Space on screen though it still
    //   reads as the current one (`lateDrops`, `blank`: the real Mac, 4 of 4 placings that moved the window early);
    // - `stageEnter` after the ask macOS switches to the new Space, if it's still there: its change is over.
    // A window the bridge moves into Margin's Space after macOS brought it into its own stays there. Moved before the
    // reserved frame, it has the display's whole size; its Space destroyed before the frame came: the same (the order
    // mistake the research run showed). `stageJump`: macOS makes the new Space current this long after the ask while the
    // window isn't in it yet (to check Margin's Space is kept current).
    var staged = false
    var stageList = 0.04, stageFrame = 0.065, stageEnter = 0.6
    var stageMember: Double? = 0.525
    var stageFrameLate: Double?
    var stageNoFrame = false
    var stageJump: Double?
    var stageJumpTo: UInt64? // (the Space made current then: none, the new one)
    struct Pending { var space: UInt64; var tile: UInt64; var asked: Double; var listed = false; var reservedAt: Double?; var framed = false; var jumped = false
                     var deliveredAt: Double?; var movedOut = false }
    var pending: [Int: Pending] = [:]
    var framedSpaces: Set<UInt64> = []
    var stagedSpaces: Set<UInt64> = []
    var destroyedBeforeFrame = 0
    var movedBeforeFrame = 0
    var movedBeforeDelivery = 0 // moves into Margin's Space before macOS had brought the window into its own
    var rehomedLate = 0 // windows macOS took back into their own Space after the bridge had moved them
    var lateDrops = 0 // windows macOS's change left in no Space (their Space destroyed before it brought them there)
    var reservedEarly: Set<Int> = [] // windows whose new Space was reserved before macOS brought them into it (the early path)
    // The display showing a Space that's gone: nothing of Margin's Space in the on-screen list, though it reads as the
    // current one. Until Margin's Space is made current again (`blankUntilPlaced`: only a new full-screen ask ends it).
    var blank = false
    var blankUntilPlaced = false
    var offMargin = 0.0 // seconds on the clock the current Space wasn't Margin's
    var framedAt: [Int: Double] = [:]
    var askedAt: [Int: Double] = [:]
    var destroyedAt: [UInt64: Double] = [:]
    var entered: Set<Int> = [] // windows still in their own Space when macOS's change was over (not moved out by then)
    var membersEarly: Set<Int> = [] // windows macOS brought into their own Space before its switch (`stageMember`)
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
            let frameDue = stageFrameLate.map { late in p.deliveredAt.map { clock - $0 + 1e-9 >= late } ?? false } ?? true
            if let at = p.reservedAt, !p.framed, !stageNoFrame, frameDue, apps[w.pid]?.sidebarOpen != true, clock - at + 1e-9 >= stageFrame {
                p.framed = true
                framedSpaces.insert(p.space)
                framedAt[n] = clock
            }
            if let j = stageJump, p.listed, !p.jumped, since >= j { p.jumped = true; current = stageJumpTo ?? p.space; currentSince = clock }
            if p.deliveredAt == nil, p.listed, since >= (stageMember ?? stageEnter) {
                p.deliveredAt = clock
                if tiles[p.space] != nil {
                    if w.member { rehomedLate += 1 }
                    w.spaces = [p.space]
                    w.priv = nil
                    w.member = false
                    w.memberFrame = nil
                    if since < stageEnter { membersEarly.insert(n) }
                } else {
                    w.spaces = []
                    w.priv = nil
                    drops += 1
                    lateDrops += 1
                    blank = true
                }
                wins[n] = w
            }
            if since >= stageEnter {
                if tiles[p.space] != nil {
                    if !p.movedOut { entered.insert(n) }
                    if jumpOnFullScreen { current = p.space; currentSince = clock }
                }
                pending[n] = nil
                continue
            }
            pending[n] = p
        }
    }
    func fullScreenSpaceOwners() -> [UInt64: pid_t]? { Dictionary(uniqueKeysWithValues: tiles.keys.map { ($0, owner[$0] ?? 0) }) }

    init() { wins[Self.marginWindow] = Win(pid: 1, spaces: [Self.marginSpace]) }

    func now() -> Double { clock }
    // Virtual time: each sleeper wakes at its own time, the clock moving to the earliest one's, so sleeps that overlap
    // (Margin's quit gives every host back at once) take the longest one's time, not their sum. A sleeper goes on once
    // its wake is the earliest for a few turns in a row (every other task has reached its own sleep, or finished).
    private var sleepers: [Int: Double] = [:]
    private var nextSleeper = 0
    func sleep(_ seconds: Double) async {
        let me = nextSleeper
        nextSleeper += 1
        let wake = clock + max(0, seconds)
        sleepers[me] = wake
        var calm = 0
        while calm < 3 {
            await Task.yield()
            calm = (sleepers.values.min() ?? wake) + 1e-12 >= wake ? calm + 1 : 0
        }
        sleepers[me] = nil
        if wake > clock {
            if current != Self.marginSpace { offMargin += wake - clock }
            clock = wake
            advance()
            for (pid, at) in uikitQuits where clock >= at { uikitQuits[pid] = nil; quitNow(pid) }
            for (n, at) in lateAsks where clock + 1e-9 >= at { lateAsks[n] = nil; if let pid = wins[n]?.pid { applyFullScreen(pid: pid, window: n, true) } }
            onClock?()
        }
        await Task.yield()
    }

    // iPad apps (FaceTime, Phone: UIKit's), as their logs show (2026-11-15): asked to quit with a window of theirs
    // ordered in (any Space, a private one too), they make themselves a background app (LaunchServices' 561, their
    // policy prohibited) and quit only after their own 5 s watchdog; with none, at once.
    var uikit: Set<String> = ["com.apple.FaceTime", "com.apple.mobilephone"]
    var uikitQuits: [pid_t: Double] = [:] // apps quitting, gone at that time on the clock
    var quitsAfter: [String: Double] = [:] // apps whose quit takes this long, whatever their windows
    // Apps that keep their windows across a quit (their own NSQuitAlwaysKeepsWindows, or the person's setting): never
    // closed first. None: macOS's default, a quit discards an app's windows.
    var keepsWindows: Set<String> = []
    func keepsWindowsAtQuit(pid: pid_t) -> Bool { apps[pid].map { keepsWindows.contains($0.bundle) } ?? false }
    // Its close button pressed by Accessibility: only for a window Accessibility reads on the current Space (when
    // axCurrentOnly) and lists; the app saves its frame as it closes.
    func close(pid: pid_t, window: Int) async -> Bool {
        calls.append("close \(window)")
        guard !fail.contains("ax"), !fail.contains("close"), let w = wins[window], w.pid == pid, !axHides(pid), !axCurrentOnly || onCurrent(window), axLists(window) || axSeen.contains(window) && onCurrent(window) else { return false }
        if apps[pid]?.refusesQuit == true { return true } // (pressed: it asks about its unsaved work, its window stays)
        if let bundle = apps[pid]?.bundle { saved[bundle] = w.frame ?? Self.defaultFrame; frameAtQuit[bundle] = w.frame ?? Self.defaultFrame; fullScreenAtQuit[bundle] = w.fullScreen }
        closeWindow(window)
        return true
    }

    // ---- apps ----
    // Apps NSWorkspace says have quit while their process goes on (a UIKit app attempting termination with no window in
    // any user Space: Maps, 2026-11-17, `isAttemptingTermination` and still running): not in `running` or `app(pid:)`,
    // their process still there (`processRuns`). `attemptTermination` posts the termination notice too.
    var lsGone: Set<pid_t> = []
    func attemptTermination(_ pid: pid_t) { lsGone.insert(pid); onAppQuit?(pid) }
    func processRuns(pid: pid_t) -> Bool { apps[pid] != nil }
    func running(bundleId: String) -> [HostApp] { apps.values.filter { $0.bundle == bundleId && !lsGone.contains($0.pid) }.sorted { $0.pid < $1.pid }.map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: $0.launchedAt) } }
    func app(pid: pid_t) -> HostApp? { lsGone.contains(pid) ? nil : apps[pid].map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: $0.launchedAt) } }
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
        if let busy = axBusyFor[bundleId] { axBusyUntil[pid] = clock + busy }
        if restoredFullScreen.contains(bundleId) {
            for n in apps[pid]?.windows ?? [] {
                let space = nextId, tile = nextId + 1
                nextId += 2
                tiles[space] = [tile]
                owner[space] = pid
                tileWindow[tile] = n
                restoredSpaces.insert(space)
                wins[n]?.fullScreen = true
                wins[n]?.spaces = [space]
            }
            hidden.insert(pid)
            noteListing()
        } else if restoredAsMember.contains(bundleId) {
            for n in apps[pid]?.windows ?? [] { wins[n]?.fullScreen = true; wins[n]?.member = true; wins[n]?.memberFrame = Self.display; wins[n]?.spaces = [current] }
        } else if launchInCurrent {
            for n in apps[pid]?.windows ?? [] where wins[n]?.spaces == [Self.desktop] { wins[n]?.spaces = [current] }
        }
        if restoredOnUnhide.contains(bundleId) { madeOnUnhide.formUnion(apps[pid]?.windows ?? []) }
        onLaunch?(pid)
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
        if let after = quitsAfter[a.bundle] { uikitQuits[pid] = clock + after; return true } // (an app slow to finish its quit)
        quitNow(pid)
        return true
    }
    func quitNow(_ pid: pid_t) {
        guard let a = apps.removeValue(forKey: pid) else { return }
        if let n = a.windows.first, let w = wins[n] { saved[a.bundle] = w.frame ?? Self.defaultFrame } // (its frame at quit)
        for n in a.windows { wins[n] = nil }
        for (space, p) in owner where p == pid { tiles[space] = nil; owner[space] = nil }
        // (Its empty tiles left in another app's Space go with it.)
        for (t, p) in emptyTiles where p == pid {
            emptyTiles[t] = nil
            for (space, list) in tiles where list.contains(t) { tiles[space] = list.filter { $0 != t }; relayFirstTwo(space) }
            tileWindow[t] = nil
        }
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
        if axBusy(pid) { frameErrors[window] = -25200; return false } // (kAXErrorCannotComplete: its app still launching)
        guard !fail.contains("ax"), !fail.contains("frame"), var w = wins[window], w.pid == pid, !axCurrentOnly || onCurrent(window), !w.fullScreen else { return false }
        guard axSeen.contains(window) || (w.axRole == nil && axLists(window)) else { return false } // (Accessibility has no element for it)
        if axStale.contains(window) { frameErrors[window] = -25202; return false } // (kAXErrorInvalidUIElement)
        frameErrors[window] = nil
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
    func activate(pid: pid_t, window: Int) async -> Bool {
        calls.append("activate \(pid) \(window)")
        if activateLag > 0 { await sleep(activateLag) }
        activated.insert(pid)
        if activateShowsDesktop, let w = wins[window], w.pid == pid, w.priv == nil, w.spaces == [Self.desktop], current != Self.desktop {
            current = Self.desktop
            currentSince = clock
        }
        return apps[pid] != nil
    }
    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool {
        calls.append("fullScreen \(on) \(window)")
        if axBusy(pid) {
            if on, let bundle = apps[pid]?.bundle, takesLate.contains(bundle), lateAsks[window] == nil, tookLate == 0 { lateAsks[window] = clock + lateTake; tookLate += 1 }
            return false
        }
        guard axReads(window), !fail.contains("ax") else { return false }
        return applyFullScreen(pid: pid, window: window, on)
    }
    // Full screen as macOS does it, whoever asked (Accessibility, or a Safari copy's setWindowState).
    @discardableResult func applyFullScreen(pid: pid_t, window: Int, _ on: Bool) -> Bool {
        guard wins[window]?.pid == pid else { return false }
        if on, wins[window]?.canFullScreen == true, wins[window]?.fullScreen == false, !fail.contains("fullScreen") { makeStrip(for: window) }
        if !on { dropStrip(of: window, asked: wins[window]?.fullScreen == false) }
        if on, wins[window]?.canFullScreen == true, !fail.contains("fullScreen") { makeToolbar(for: window) }
        if !on, wins[window]?.fullScreen == true { dropToolbar(of: window) }
        guard var w = wins[window], w.pid == pid else { return false }
        if on, !w.canFullScreen { return false } // (AXFullScreen isn't settable)
        if on {
            guard !w.fullScreen, !fail.contains("fullScreen") else { return true }
            if let a = apps[pid], desktopOnlyFullScreen.contains(a.bundle), w.priv == nil, w.spaces.contains(where: { tiles[$0] != nil }) { refusedAsks += 1; return true }
            if currentOnlyFullScreen, w.priv != nil || !w.spaces.contains(current) { refusedAsks += 1; return true }
            let space = nextId, tile = nextId + 1
            nextId += 2
            if staged {
                blank = false
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
                    if w.tiled, exitLeavesTile, owner[space] != pid {
                        for t in list where tileWindow[t] == window { emptyTiles[t] = pid } // (left behind, empty)
                        continue
                    }
                    tiles[space] = list.filter { tileWindow[$0] != window }
                    if owner[space] == pid, tiles[space]?.isEmpty == true { tiles[space] = nil; owner[space] = nil } // macOS closes its own Space
                    else { relayFirstTwo(space) } // (a tile taken out: the first two laid out again)
                }
                for (t, n) in tileWindow where n == window { tileWindow[t] = nil; tileRects[t] = nil }
                w.tiled = false
                if w.priv == nil || exitUnparks { w.priv = nil; w.spaces = [Self.desktop] }
            }
        }
        wins[window] = w
        noteListing()
        return true
    }
    var fullScreenUnread: Set<Int> = [] // windows whose AXFullScreen doesn't read (set, it's taken)
    func isFullScreen(pid: pid_t, window: Int) async -> Bool? {
        guard axReads(window), !fullScreenUnread.contains(window), !fail.contains("ax") else { return nil }
        return wins[window].flatMap { $0.pid == pid ? $0.fullScreen : nil }
    }
    var main: [pid_t: Int] = [:] // the app's main window; none set: its last window
    var focused: [pid_t: Int] = [:] // its focused window; none set: none
    var axAppUnread = false // the app's main and focused windows don't read
    func mainWindow(pid: pid_t) async -> Int? {
        guard !axAppUnread, !axHides(pid), let n = main[pid] ?? apps[pid]?.windows.last(where: { toolbarHost($0) == nil }) else { return nil }
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
            guard let w = wins[n], w.pid == pid, serverMade(n), let b = bounds(window: n) else { return nil }
            return ServerWindow(number: n, pid: pid, bounds: b, onScreen: onCurrent(n) && !orderedOut.contains(n) && !hiddenInFullScreen(n))
        }
        return own + serverExtra.filter { $0.pid == pid }
    }
    // A full-screen window in a Space of its own: that Space's area less its reservation (Safari's with its sidebar open
    // doesn't take it); a member: the frame it had as it came in; Margin's window: the whole area.
    func bounds(window: Int) -> CGRect? {
        guard let w = wins[window] else { return nil }
        if let h = toolbarHost(window) { return bounds(window: h).map { CGRect(x: $0.minX, y: $0.minY - Self.toolbarHeight, width: $0.width, height: Self.toolbarHeight) } }
        if let lag = lagging[window], clock < lag.until { return lag.frame }
        if window == Self.marginWindow { return tilesOn ? tileBounds(Self.marginTile) : Self.display }
        if w.tiled, w.fullScreen, let t = tileOf(window) { return tileBounds(t) }
        if w.member, let f = w.memberFrame { return f }
        if let p = pending[window] { return p.framed ? (reservation[p.space] ?? .zero).inset(Self.display) : (w.frame ?? Self.defaultFrame) }
        guard w.fullScreen, w.priv == nil, let space = w.spaces.first, tiles[space] != nil else { return w.frame ?? Self.defaultFrame }
        let sidebar = apps[w.pid]?.sidebarOpen == true || apps[w.pid].map { noLayout.contains($0.bundle) } == true
        return (sidebar ? .zero : (reservation[space] ?? .zero)).inset(Self.display)
    }
    // As the real Mac (2026-11-17, check10): a Space destroyed in the same breath as a window's move out of it takes the
    // window with it. The window server still says it's where it was moved to, and a moment later it's in no Space at
    // all: at its frame, on no screen. `dropWithin`: a destroy this soon after the move does it (nil: never);
    // `dropNext`: this many next destroys do it whatever the gap; `dropAfter`: how long after the destroy it shows.
    var dropWithin: Double?
    var dropNext = 0
    var dropAfter = 0.1
    var movedOut: [Int: (space: UInt64, at: Double)] = [:] // each window's last move out of a Space: which, and when
    var dropAt: [Int: Double] = [:]
    var drops = 0
    // macOS finishing its own full-screen change after the window was moved out early: the window back in its own
    // Space, if that's still there, `rehomeAfter` after that move (nil: never), once.
    var rehomeAfter: Double?
    var rehomeAt: [Int: (space: UInt64, at: Double)] = [:]
    var rehomes = 0
    func noteDestroy(_ space: UInt64) {
        for (n, m) in movedOut where m.space == space {
            if dropNext > 0 { dropNext -= 1; dropAt[n] = clock + dropAfter } else if let within = dropWithin, clock - m.at < within { dropAt[n] = clock + dropAfter }
        }
    }
    // Every app's windows on screen now, front to back (nil: no list): what a test says is there.
    // `autoOnScreen`: none said: the windows of the current Space (Margin's first), none of them while the display shows
    // a Space that's gone (`blank`), nor a hidden app's, nor a minimized one (`minimized`).
    var onScreen: [ServerWindow]?
    var autoOnScreen = false
    var minimized: Set<Int> = []
    var away = false
    var onScreenRead: (() -> Void)? // (run as the list is read: a Space change under way meanwhile)
    var serverSpaces: [Int: [UInt64]] = [:] // the Spaces read for windows only the on-screen list has
    // `listDrops`: the on-screen list leaves a window out this many next reads though it's on screen (its own read says
    // so: `windowOnScreen`). `ownReads`: how many times a window's own read was asked.
    var listDrops: [Int: Int] = [:]
    var ownReads = 0
    func shows(_ n: Int) -> Bool { if let h = toolbarHost(n) { return shows(h) }; return !blank && !orderedOut.contains(n) && !hiddenInFullScreen(n) && (wins[n].map { $0.priv == nil && $0.spaces.contains(current) && !hidden.contains($0.pid) && !minimized.contains(n) } ?? false) }
    func onScreenWindows() -> [ServerWindow]? {
        onScreenRead?()
        if let onScreen { return onScreen }
        guard autoOnScreen else { return nil }
        if blank { return [] }
        let dropped = Set(listDrops.filter { $0.value > 0 }.keys)
        for n in dropped { listDrops[n]? -= 1 }
        return wins.keys.sorted().filter { n in shows(n) && !dropped.contains(n) }
            .compactMap { n in bounds(window: n).map { ServerWindow(number: n, pid: wins[n]?.pid ?? 0, layer: n == Self.marginWindow ? 1 : 0, bounds: $0) } }
    }
    func windowOnScreen(_ number: Int) -> (onScreen: Bool, alpha: Double)? {
        ownReads += 1
        guard autoOnScreen, wins[number] != nil else { return nil }
        return (shows(number), 1)
    }
    func screenAway() -> Bool { away }
    func currentSpaces() -> [String]? { ["\(current)\(blank ? " (not listed)" : "")"] }
    func spaces(window: Int) -> [UInt64]? {
        if let h = toolbarHost(window) { return spaces(window: h) }
        if wins[window] == nil, let s = serverSpaces[window] { return s }
        if let at = dropAt[window], clock >= at {
            dropAt[window] = nil
            landing[window] = nil
            wins[window]?.spaces = []
            wins[window]?.priv = nil
            drops += 1
        }
        if let r = rehomeAt[window], clock >= r.at {
            rehomeAt[window] = nil
            if tiles[r.space] != nil { wins[window]?.spaces = [r.space]; wins[window]?.priv = nil; rehomes += 1 }
        }
        if let l = landing[window], clock < l.until { return l.spaces }
        return wins[window].map { $0.priv != nil ? [] : $0.spaces }
    }
    func spaceType(_ space: UInt64) -> Int? { tiles[space] != nil ? 4 : (space == Self.desktop ? 0 : nil) }
    func spaceExists(_ space: UInt64) -> Bool? { tiles[space] != nil || space == Self.desktop }
    func currentSpace(onDisplayOf space: UInt64) -> UInt64? { current }
    func setCurrentSpace(_ space: UInt64) -> Bool {
        calls.append("current \(space)")
        guard !fail.contains("setCurrent") else { return false }
        current = space
        currentSince = clock
        if space == Self.marginSpace, !blankUntilPlaced { blank = false }
        return true
    }
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
        noteDestroy(space)
        for (n, p) in pending where p.space == space {
            // (Destroyed before its window had the page frame: full screen where it is, at the display's whole size.)
            if !p.framed { destroyedBeforeFrame += 1; wins[n]?.member = true; wins[n]?.memberFrame = Self.display }
            // (Once macOS has brought the window into it, its change has nothing more to do with a Space that's gone.
            // Before: it goes on, and brings the window into no Space: `advance`.)
            if p.deliveredAt != nil { pending[n] = nil }
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
        for (n, p) in pending where p.space == space && p.reservedAt == nil { pending[n]?.reservedAt = clock; if p.deliveredAt == nil { reservedEarly.insert(n) } }
        return true
    }
    func reserved(space: UInt64) -> SlotEdges? { reservation[space] ?? .zero }

    // ---- parking, members ----
    func createPrivateSpace() -> UInt64? { let s = nextId; nextId += 1; privates.insert(s); return s }
    func move(window: Int, to space: UInt64) -> Bool {
        calls.append("move \(window) \(space)")
        if let h = toolbarHost(window) { return move(window: h, to: space) }
        guard var w = wins[window], !(fail.contains("moveIn") && space == Self.marginSpace), !(noMoveIn.contains(window) && space == Self.marginSpace) else { return false }
        let before = spaces(window: window) ?? []
        if let from = pending[window]?.space ?? w.priv ?? w.spaces.first(where: { $0 != space && tiles[$0] != nil }) { movedOut[window] = (from, clock) }
        if let after = rehomeAfter, rehomes == 0, space == Self.marginSpace, let from = pending[window]?.space ?? w.spaces.first(where: { $0 != space && tiles[$0] != nil && owner[$0] == w.pid }) {
            rehomeAt[window] = (from, clock + after)
        }
        if let p = pending[window], !privates.contains(space), tiles[space] != nil {
            // (A member here at the bounds it has now. macOS's own change goes on: moved in before macOS brought it into
            // its own Space, it's taken there when that comes; after, it stays.)
            if p.deliveredAt == nil { movedBeforeDelivery += 1 } else { pending[window]?.movedOut = true }
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
        if w.tiled, rejoinRelays, w.priv != nil, !privates.contains(space), let t = tileOf(window), tiles[space]?.firstIndex(of: t) == 1 {
            w.priv = nil
            w.spaces = [space]
            wins[window] = w
            relayFirstTwo(space)
            return true
        }
        if privates.contains(space) {
            guard !fail.contains("park"), !unparkable.contains(window) else { return false }
            w.priv = space
            if apps[w.pid].map({ staleOnLeave.contains($0.bundle) }) == true { axStale.insert(window) }
        } else {
            // A full-screen window brought into another full-screen Space: a member there, at the frame it had (a tiled one
            // is back with its tile, which never left).
            if w.fullScreen, !w.member, !w.tiled, tiles[space] != nil {
                w.memberFrame = moveLosesFrame > 0 ? Self.display : bounds(window: window)
                if moveLosesFrame > 0 { moveLosesFrame -= 1 }
                w.member = true
            }
            w.priv = nil
            w.spaces = [space]
            arrivedAt[window] = clock
        }
        wins[window] = w
        if moveLag > 0 { landing[window] = (before, clock + moveLag) }
        return true
    }
    func destroyPrivateSpace(_ space: UInt64) -> Bool { noteDestroy(space); return privates.remove(space) != nil }

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

    // ---- the tiles (live resize), as the kit measured them (2026-11-17, /tmp/margin-toolbar-test/live-resize/opt4) ----
    // A full-screen Space's tiles in its layout's order (`tiles`, above), each with its window (`tileWindow`) and its rect
    // (`tileRects`: the display's points from its top left, the menu bar's band in; none set: the display's whole). A
    // full-screen window is that band below its tile's top. A Space takes `Max Tile Config` tiles (2 for a new one: a
    // tile moved in past it isn't taken); a tile moved in or taken out lays the first two of its layout out again (a
    // split's halves: their rects wiped); rects may overlap. Off (`tilesOn` false): every older check runs as before.
    var tilesOn = false
    var tileRects: [UInt64: CGRect] = [:]
    var maxTileConfig: [UInt64: Int] = [:]
    var limitIgnored = false // the Space's tile limit never takes (the launch check fails)
    var rectsIgnored = false // a tile's rect never takes (its window stays where its layout put it)
    var moveRefused = false // the bridge's tile move is sent and nothing moves
    var liveResizing: [UInt64: Bool] = [:]
    var relaid = 0 // layouts laid out again by a tile change
    var placeholders: Set<UInt64> = [] // tiles left with no window by an app that was killed
    // A tiled window out of full screen leaves its tile in that Space, empty, until its app quits (the real Mac,
    // 2026-11-17 23:32: Margin's Space outlived Margin's quit with such a tile in it). Off: the tile goes with it.
    var exitLeavesTile = true
    // A tiled window that's its layout's second coming back into that Space (a switch) lays the first two out again (the
    // real Mac, 2026-11-17 23:31:42: Chameleon 1, the second tile of Margin's Space, at a third's width as it was shown).
    var rejoinRelays = false
    var emptyTiles: [UInt64: pid_t] = [:]
    static let tileDisplay = CGRect(x: 0, y: 0, width: 1512, height: 982), band: CGFloat = 33
    func tileOf(_ window: Int) -> UInt64? { tileWindow.first { e in e.value == window && tiles.values.contains { $0.contains(e.key) } }?.key }
    func tileBounds(_ t: UInt64) -> CGRect {
        let r = tileRects[t] ?? Self.tileDisplay
        return CGRect(x: r.minX, y: r.minY + Self.band, width: r.width, height: r.height - Self.band)
    }
    func relayFirstTwo(_ space: UInt64) {
        guard tilesOn, let list = tiles[space], !list.isEmpty else { return }
        relaid += 1
        let full = Self.tileDisplay
        if list.count == 1 { tileRects[list[0]] = full; return }
        let half = ((full.width - 12) / 2).rounded(.down)
        tileRects[list[0]] = CGRect(x: 0, y: 0, width: half, height: full.height)
        tileRects[list[1]] = CGRect(x: full.width - half, y: 0, width: half, height: full.height)
    }
    var tilesAvailable: Bool { tilesOn }
    func tiles(of space: UInt64) -> [UInt64]? { tilesOn ? tiles[space] : nil }
    func tileRect(_ tile: UInt64) -> CGRect? { tilesOn && tiles.values.contains { $0.contains(tile) } ? tileRects[tile] ?? Self.tileDisplay : nil }
    func tileWindow(_ tile: UInt64) -> Int? { tilesOn ? tileWindow[tile] : nil }
    func maxTiles(of space: UInt64) -> Int? { tilesOn && tiles[space] != nil ? maxTileConfig[space] ?? 2 : nil }
    func setMaxTiles(_ space: UInt64, _ count: Int) -> Bool {
        calls.append("maxTiles \(space) \(count)")
        guard tilesOn else { return false }
        if !limitIgnored { maxTileConfig[space] = count }
        return true
    }
    func setTileRect(_ tile: UInt64, _ rect: CGRect) -> Bool {
        calls.append("tileRect \(tile) \(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))×\(Int(rect.height))")
        guard tilesOn else { return false }
        if !rectsIgnored { tileRects[tile] = rect }
        return true
    }
    func moveTile(_ tile: UInt64, to space: UInt64, index: Int) -> Bool {
        calls.append("moveTile \(tile) \(space) \(index)")
        guard tilesOn else { return false }
        guard !moveRefused, let from = tiles.first(where: { $0.value.contains(tile) })?.key, from != space, var list = tiles[space], list.count + 1 <= maxTileConfig[space] ?? 2 else { return true }
        tiles[from] = tiles[from]?.filter { $0 != tile }
        list.insert(tile, at: min(index, list.count))
        tiles[space] = list
        if let n = tileWindow[tile], var w = wins[n] {
            let before = spaces(window: n) ?? []
            if pending[n] != nil { pending[n]?.movedOut = true }
            movedOut[n] = (from, clock)
            w.tiled = true
            w.member = false
            w.memberFrame = nil
            w.priv = nil
            w.spaces = [space]
            arrivedAt[n] = clock
            wins[n] = w
            if moveLag > 0 { landing[n] = (before, clock + moveLag) }
        }
        relayFirstTwo(space)
        noteListing()
        return true
    }
    func destroyTile(_ tile: UInt64) -> Bool {
        calls.append("destroyTile \(tile)")
        guard tilesOn else { return false }
        for (space, list) in tiles where list.contains(tile) { tiles[space] = list.filter { $0 != tile }; relayFirstTwo(space) }
        if let n = tileWindow[tile], wins[n] != nil, emptyTiles[tile] == nil { destroyedWithWindows += 1 }
        emptyTiles[tile] = nil
        tileWindow[tile] = nil
        tileRects[tile] = nil
        placeholders.remove(tile)
        return true
    }
    func setLiveResizing(_ space: UInt64, _ on: Bool) -> Bool {
        calls.append("liveResizing \(space) \(on)")
        guard tilesOn else { return false }
        liveResizing[space] = on
        return true
    }
    // An app killed (SIGKILL): its windows go, its tiles in another app's Space stay as placeholders (a window number of
    // their own, none of the app's), its own Spaces go.
    func killApp(_ pid: pid_t) {
        guard let a = apps.removeValue(forKey: pid) else { return }
        let itsSpaces = Set(owner.filter { $0.value == pid }.map(\.key))
        for n in a.windows {
            for (t, w) in tileWindow where w == n {
                if tiles.contains(where: { !itsSpaces.contains($0.key) && $0.value.contains(t) }) { tileWindow[t] = nextWindow; nextWindow += 1; placeholders.insert(t) } else { tileWindow[t] = nil }
            }
            wins[n] = nil
        }
        for (space, p) in owner where p == pid { tiles[space] = nil; owner[space] = nil }
        noteListing()
        onAppQuit?(pid)
    }
    // Margin killed: its own tile out of its Space, which stays with no owner and the hosted tiles: the first two laid
    // out as a split, seen.
    func marginKilled() {
        for (space, list) in tiles where list.contains(Self.marginTile) { tiles[space] = list.filter { $0 != Self.marginTile }; relayFirstTwo(space) }
        tileWindow[Self.marginTile] = nil
        wins[Self.marginWindow] = nil
        owner[Self.marginSpace] = nil
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
    // Apps that keep a window after its close (an NSWindow not released when closed: every Chameleon's, many real apps'):
    // the window server lists it a while yet, off screen, a full-screen one at its normal frame in no Space, a window-mode
    // one where it was; Accessibility no longer has it, its element destroyed (told: `onDestroyed`). The real Mac,
    // 2026-11-17 19:04 (Chameleon's windowless close: "74324 in [9158] → in no Space", its bounds 260,220 900×560).
    var keepsClosed: Set<String> = []
    var closedWins: Set<Int> = []
    var onDestroyed: ((pid_t, Int) -> Void)?
    func closeWindow(_ n: Int) {
        guard var w = wins[n] else { return }
        for (space, list) in tiles where list.contains(where: { tileWindow[$0] == n }) {
            tiles[space] = list.filter { tileWindow[$0] != n }
            if owner[space] == w.pid, tiles[space]?.isEmpty == true { tiles[space] = nil; owner[space] = nil } else { relayFirstTwo(space) }
        }
        w.tiled = false
        apps[w.pid]?.windows.removeAll { $0 == n }
        if let bundle = apps[w.pid]?.bundle, keepsClosed.contains(bundle) {
            if w.fullScreen || w.member { w.spaces = [] }
            w.priv = nil
            w.fullScreen = false
            w.member = false
            w.memberFrame = nil
            wins[n] = w
            closedWins.insert(n)
            orderedOut.insert(n)
        } else {
            wins[n] = nil
        }
        noteListing()
        onDestroyed?(w.pid, n)
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
    var exitWorks = true // …and out of it when asked (false: the copy answers, Safari's window stays as it is)
    var ignoresEntries = 0 // this many asks into full screen answered and not done (Safari mid-change), then done
    var busyAsks = 0 // this many asks not taken by the copy (busy with another call for the window), then taken
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
        if busyAsks > 0 { busyAsks -= 1; return false }
        if on, ignoresEntries > 0 { ignoresEntries -= 1; return true }
        if on ? fullScreenWorks : exitWorks { world.applyFullScreen(pid: p, window: n, on) }
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
    var functions = Set(HostCalls.skyFunctions + HostCalls.launchFunctions + HostCalls.launchKeys + HostCalls.noteFunctions + HostCalls.tileFunctions)
    var encodings = Dictionary(uniqueKeysWithValues: (HostCalls.selectors + HostCalls.tileSelectors).map { ($0.label, $0.encoding) })
    var hasClass = true
    var tileClasses = Set(HostCalls.tileClasses)
    func open(_ framework: PrivateFramework) -> Bool { frameworks.contains(framework) }
    func function(_ name: String, in framework: PrivateFramework) -> UnsafeRawPointer? {
        guard frameworks.contains(framework), functions.contains(name) else { return nil }
        return UnsafeRawPointer(bitPattern: 0x1000) // never called
    }
    func objcClass(_ name: String) -> AnyClass? { (hasClass && name == HostCalls.destroyClass) || tileClasses.contains(name) ? NSObject.self : nil }
    func responds(_ className: String, _ selector: String) -> Bool { (className == HostCalls.destroyClass ? hasClass : tileClasses.contains(className)) && encodings["\(className) -\(selector)"] != nil }
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
        e.options.privateRetire = 0 // (a private Space destroyed as its window leaves it, as these checks count them; the deferred way has its own checks)
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
        e.hostedWindow = { s.above.append($0) }
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
        check("host: started with no Dock icon, never showing its own title strip, never ended by automatic termination", w.apps[p]?.policy == .accessory && w.lastArguments == ["-NSMenuEnableMenuBarAgent", "NO", "-NSDisableAutomaticTermination", "YES"], "\(w.lastArguments)")
        check("host: its own full-screen Space reserved at the page area's four edges (Margin's never)", w.reserves.map(\.edges) == [edges] && own != FakeHostWorld.marginSpace
              && w.reservation[FakeHostWorld.marginSpace] == nil, "\(w.reserves)")
        check("host: its window a member of Margin's Space, still full screen, at the page area", w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.wins[n]?.fullScreen == true
              && w.wins[n]?.member == true && w.bounds(window: n) == page, "\(String(describing: w.wins[n]))")
        check("host: its own Space destroyed once its window left it: Mission Control lists Margin's Space only", w.tiles[own] == nil && clean(w), "\(w.tiles)")
        check("host: Margin's window its whole width (never a tile)", w.bounds(window: FakeHostWorld.marginWindow) == FakeHostWorld.display)
        let jump = at(w, "current \(FakeHostWorld.marginSpace)"), member = at(w, "move \(n) \(FakeHostWorld.marginSpace)"), destroy = at(w, "destroy \(own)")
        check("host: macOS's jump to its new Space undone, then reserved, then the move, then the destroy (Margin's Space current)",
              jump >= 0 && jump < at(w, "reserve \(edges.text)") && at(w, "reserve \(edges.text)") < member && member < destroy && w.current == FakeHostWorld.marginSpace, "\(w.calls)")
        check("host: its app in front after it's shown, Margin's window kept below its window", w.calls.last == "activate \(p) \(n)" && said.above == [n] && e.shownWindow == n, "\(w.calls.suffix(3)) \(said.above)")
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
    // window moved in and that Space destroyed only once macOS has brought the window into it and switched to it
    // (undone), all under one freeze ----
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
        check("early: its Space reserved as soon as it was listed, before macOS brought its window into it (the page frame comes from macOS's own layout)",
              w.reserves.map(\.edges) == [edges] && w.stagedSpaces.contains(own) && w.reservedEarly.contains(n) && w.membersEarly.contains(n), "\(w.reserves) \(w.membersEarly) \(w.reservedEarly)")
        let moved = w.movedOut[n]?.at ?? -1
        check("early: its window moved into Margin's Space only after macOS had brought it into its own Space and switched to it (\(Int(((moved - asked) * 1000).rounded())) ms after the ask; the page frame had come at \(Int(((framed - asked) * 1000).rounded())) ms): never moved on the page frame alone",
              w.movedBeforeDelivery == 0 && w.rehomedLate == 0 && w.lateDrops == 0 && moved - asked >= 0.6 && framed - asked < 0.2 && w.calls.filter { $0 == "current \(FakeHostWorld.marginSpace)" }.count == 1,
              "moved \(moved - asked) framed \(framed - asked) before delivery \(w.movedBeforeDelivery)")
        let reserve = at(w, "reserve \(edges.text)"), move = at(w, "move \(n) \(FakeHostWorld.marginSpace)"), destroy = at(w, "destroy \(own)")
        check("early: reserved, then (the page frame) moved in, then its Space destroyed: never destroyed or moved before the frame",
              reserve >= 0 && reserve < move && move < destroy && w.destroyedBeforeFrame == 0 && w.movedBeforeFrame == 0 && framed >= 0 && framed <= destroyed, "\(w.calls)")
        check("early: under one freeze from the ask until it's in place (macOS's switch to the new Space, undone within one read, is never seen)",
              w.freezes == 1 && w.reveals == 1 && w.offMargin <= 0.0051 && w.current == FakeHostWorld.marginSpace, "\(w.freezes) \(w.offMargin)")
        check("early: its Space destroyed \(Int((destroyed - asked) * 1000)) ms after the ask on the stand-in's clock (macOS's change over at 600, the move held 50)",
              asked >= 0 && destroyed - asked >= 0.65 && destroyed - asked < 0.75, "\(asked) \(framed) \(destroyed)")
        check("early: Mission Control listed its Space only until then; nothing left", w.episodes.count == 1 && (w.episodes.first ?? 9) < 0.75 && clean(w), "\(w.episodes)")
        check("early: its app in front, Margin's window kept below it, the loading bar for it", w.calls.last == "activate \(p) \(n)" && said.above == [n] && said.loading == [textEdit.id, nil])
        check("early: the log says the early path and each step's ms", lines.contains { $0.contains("full screen by the early path") && $0.contains("listed") && $0.contains("in its Space") && $0.contains("page-sized") && $0.contains("in place, its Space gone") }
              && lines.contains { $0.contains("early (listed") }, "\(lines.filter { $0.contains("early") })")
        check("early: the marker lists it as a member, no Space of its own", HostMarker.read(marker)?.windows.first?.member == true && HostMarker.read(marker)?.windows.first?.fullScreenSpace == nil)
        check("early: a switch back and forth after it still instant", { _ = open(e, notes); let t = w.clock; _ = hostRun { await e.show(textEdit.id) }; return w.clock - t < 0.1 && w.inMargin == [n] && clean(w) }())
        check("early: the second app early too, one freeze each", w.freezes == 2 && w.reveals == 2 && w.movedBeforeDelivery == 0 && w.reservedEarly.count == 2, "\(w.freezes) \(w.reservedEarly)")

        // ---- placed again (the page area moved): its exit seen (under the freeze), its entry early under the same freeze ----
        let page2 = CGRect(x: 272, y: 61, width: 1220, height: 900)
        w.calls = []
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        check("early: placed again at a new page area, through the early path, one freeze for its exit and its entry", ok == true && w.bounds(window: n) == page2 && w.wins[n]?.member == true
              && w.freezes == 3 && w.reveals == 3 && w.movedBeforeDelivery == 0 && w.lateDrops == 0 && w.destroyedBeforeFrame == 0 && clean(w), "\(w.calls) \(w.freezes)")
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
        check("early: the new Space made current by macOS before its window is in it: Margin's current again at once (\(Int(w.offMargin * 1000)) ms off it, each time), still early",
              r == .shown(textEdit.id, placed: true) && w.offMargin <= 0.0102 && w.calls.contains("current \(FakeHostWorld.marginSpace)") && w.freezes == 1 && w.reveals == 1 && w.movedBeforeDelivery == 0 && w.bounds(window: n) == page
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
              && !w.calls.contains("current \(FakeHostWorld.marginSpace)") && w.freezes == 1 && w.reveals == 1 && w.dropped == 0, "\(w.calls)")
    }
    do {
        // A Desktop the person went to meanwhile: left alone; when macOS's switch to the new Space takes them from it, the
        // Desktop is what's made current again, not Margin's Space.
        let (w, e, _) = world()
        w.staged = true
        w.stageJump = 0.05
        w.stageJumpTo = FakeHostWorld.desktop
        let r = open(e, textEdit)
        check("early: a Desktop the person went to meanwhile: never taken from it to Margin's Space, back on it after macOS's own switch; still early",
              r == .shown(textEdit.id, placed: true) && w.current == FakeHostWorld.desktop && !w.calls.contains("current \(FakeHostWorld.marginSpace)") && w.calls.contains("current \(FakeHostWorld.desktop)")
              && w.movedBeforeDelivery == 0 && w.dropped == 0, "\(w.calls)")
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
        // The real Mac's other pacing (its logs of 2026-11-17, 10 of 10 placings that held): the page frame only once
        // the window is in its own Space (~525 ms), macOS's switch to that Space at 0.6 s: the same order, still early.
        let (w, e, _) = world()
        w.staged = true
        w.stageFrameLate = 0.05
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let n = window(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        check("early: the page frame only after its window is in its own Space, then macOS's switch: undone at once (\(Int(w.offMargin * 1000)) ms off Margin's Space), moved in after it, still early, one freeze",
              r == .shown(textEdit.id, placed: true) && w.membersEarly.contains(n) && w.reservedEarly.contains(n) && w.freezes == 1 && w.reveals == 1 && w.offMargin <= 0.0051 && w.bounds(window: n) == page
              && w.wins[n]?.member == true && (w.framedAt[n] ?? 0) - (w.askedAt[n] ?? 0) >= 0.57 && w.movedBeforeDelivery == 0 && w.lateDrops == 0
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
            var lines: [String] = []
            let echo = Diagnostics.echo
            Diagnostics.echo = { lines.append($0) }
            let r = open(e, target)
            Diagnostics.echo = echo
            let mine = e.hosts[target.id]?.window ?? 0
            let early = lines.contains { $0.contains("full screen by the early path") }, fellBack = lines.contains { $0.contains("fell back") }
            check("early: Safari's window \(open_ ? "with its sidebar open: the slow path, its sidebar hidden" : "early through its copy"), under the freeze",
                  r == .shown(target.id, placed: true) && copy.fullScreens == ["7914 on"] && w.bounds(window: mine) == page && w.wins[mine]?.member == true
                  && w.apps[safariPid]?.sidebarOpen == false && w.freezes >= 1 && w.freezes == w.reveals && w.movedBeforeDelivery == 0 && w.lateDrops == 0 && (open_ ? fellBack && !early : early && !fellBack)
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
        hostRun { await e.close(textEdit.id) } // (its exit not waited for: still running 6 s after the ask, the poll says so)
        check("host: an app that doesn't quit: its row's close didn't wait, nothing said yet", w.apps[p] != nil && e.exitingPids == [p] && events.allSatisfy { if case .failed = $0 { return false }; return true })
        hostRun { await w.sleep(6) }
        e.poll()
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
        let kept = e.hosts[notes.id] != nil && !events.contains(.windowClosed(notes.id))
        w.clock += HostReconciler.goneGrace + 0.1
        e.poll()
        _ = hostRun { await e.activateShown(at: nil); return true } // (what the poll queued, run to its end)
        check("host: its window closed: kept for the grace (another main window of its app's would be adopted), then its item closed: said, forgotten; nothing reopened",
              kept && events.contains(.windowClosed(notes.id)) && e.hosts.isEmpty && !w.calls.contains { $0.hasPrefix("reopen") }, "\(kept) \(events)")
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
              && w.lastArguments == ["-NSMenuEnableMenuBarAgent", "NO", "-AutoShowToolbarInFullScreen", "YES", "-NSDisableAutomaticTermination", "YES"] && w.apps[started]?.policy == .accessory && clean(w), "\(String(describing: r))")
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

    // ---- a placing again never loses the window (2026-11-17: the second one in a row did) ----
    do {
        // Safari's copy answers the ask out of full screen ("normal", 64 ms after it on the real Mac) while its window
        // is still the full-screen member it was: never taken as out on the copy's word. The window server shows it at
        // the frame it had, so the placing doesn't start: kept shown as it is, in Margin's Space, never closed or parked.
        let (w, e, _) = world()
        w.axCurrentOnly = true // (as the real Mac: Accessibility reads only the current Space's windows; parked, it doesn't read)
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = open(e, .safariWindow(nil))
        let mine = copy.windowOf[7914] ?? 0
        let safari = HostTarget.safariWindow(nil).id
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let said = watch(e)
        copy.exitWorks = false
        let page2 = CGRect(x: 316, y: 41, width: 1188, height: 933)
        w.calls = []
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        check("host: a placing whose exit Safari's copy answers but the window server doesn't show: never taken as out, the window kept shown as it was (a member of Margin's Space at the frame it had), said, not placed",
              ok == false && e.shown == safari && e.hosts[safari]?.phase == .shown && w.inMargin == [mine] && w.wins[mine]?.fullScreen == true && w.bounds(window: mine) == page
              && e.hosts[safari]?.placedPage == page && !w.calls.contains { $0.hasPrefix("copy close") } && copy.isOpen(7914) && said.above.last == .some(mine)
              && events.contains { if case .failed(safari, .exitFullScreen, _) = $0 { return true }; return false } && !events.contains(.unshown(safari)) && clean(w),
              "\(String(describing: ok)) shown \(String(describing: e.shown)) \(w.calls) \(events)")
        check("host: … never asked into full screen again while it hadn't left (the ask that was lost mid-exit)", copy.fullScreens.filter { $0 == "7914 on" }.count == 1, "\(copy.fullScreens)")
        // Its exit working again: the next change of the page area places it.
        copy.exitWorks = true
        let page3 = CGRect(x: 300, y: 41, width: 1204, height: 933)
        let again = hostRun { await e.pageRectChanged(placed(page3)) }
        check("host: … and placed at the next change of the page area, once its exit shows", again == true && e.shown == safari && w.bounds(window: mine) == page3 && w.inMargin == [mine] && clean(w), "\(String(describing: w.bounds(window: mine)))")
    }
    do {
        // The copy busy with another call for the window as the exit is asked (its last ask still pending): asked again.
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = open(e, .safariWindow(nil))
        let mine = copy.windowOf[7914] ?? 0
        copy.busyAsks = 2
        let page2 = CGRect(x: 316, y: 41, width: 1188, height: 933)
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        check("host: a placing while Safari's copy is busy with another call for the window: its exit asked again until it's taken, then placed",
              ok == true && w.bounds(window: mine) == page2 && copy.fullScreens.filter { $0 == "7914 off" }.count == 3 && w.inMargin == [mine] && clean(w), "\(copy.fullScreens)")
    }
    do {
        // Out of full screen, and the ask back in not done (Safari still changing): its app brought in front before
        // it's asked once more (macOS ignores a full-screen ask for an app that isn't active), then placed.
        let (w, e, _) = world()
        e.options.earlyFullScreen = false
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = open(e, .safariWindow(nil))
        let mine = copy.windowOf[7914] ?? 0
        copy.ignoresEntries = 1
        w.calls = []
        let page2 = CGRect(x: 316, y: 41, width: 1188, height: 933)
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        let asks = w.calls.indices.filter { w.calls[$0] == "copy fullScreen 7914 true" }
        let front = w.calls.firstIndex(of: "activate \(safariPid) \(mine)") ?? -1
        check("host: a placing whose first ask into full screen isn't done: Safari brought in front, then asked once more, placed at the new page area",
              ok == true && asks.count == 2 && front > asks[0] && front < asks[1] && w.bounds(window: mine) == page2 && w.inMargin == [mine] && clean(w), "\(w.calls)")
    }

    // ---- the one shown found outside Margin's Space with Margin's window still in it: brought back, never unshown ----
    // (2026-11-17: 0.4-0.7 s after the first show of the Safari window made ready at launch, "parked, nothing shown":
    // the launcher again, a second click needed.)
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = open(e, .safariWindow(nil))
        let mine = copy.windowOf[7914] ?? 0
        let safari = HostTarget.safariWindow(nil).id
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let said = watch(e)
        func settle() { _ = hostRun { await e.activateShown(at: nil); return true }; _ = hostRun { await e.pageRectChanged(placed(page)) } } // (the poll's own step, then the next operation after it)
        // Something moved it to the Desktop, still full screen at its frame (its app finishing its own change late).
        w.wins[mine]?.spaces = [FakeHostWorld.desktop]
        e.poll()
        check("host: one read with the shown window out of Margin's Space: not yet (a read can miss mid-transition)", e.shown == safari && w.spaces(window: mine) == [FakeHostWorld.desktop])
        e.poll()
        settle()
        check("host: the shown window found on a Desktop (two reads), Margin's window still in its Space: moved back into Margin's Space as it is, still shown at the page area, never unshown or parked; Margin's window told its window again",
              e.shown == safari && e.hosts[safari]?.phase == .shown && w.inMargin == [mine] && w.spaces(window: mine) == [FakeHostWorld.marginSpace] && w.bounds(window: mine) == page && w.wins[mine]?.fullScreen == true
              && !events.contains(.unshown(safari)) && !events.contains(.parked(safari)) && said.above.last == .some(mine) && clean(w), "\(events) \(String(describing: w.spaces(window: mine)))")
        // In a full-screen Space of its own again (its app made one for it): back, and that Space gone from Mission Control.
        let space = w.nextId, tile = w.nextId + 1
        w.nextId += 2
        w.tiles[space] = [tile]
        w.owner[space] = safariPid
        w.wins[mine]?.spaces = [space]
        w.noteListing()
        e.poll()
        e.poll()
        settle()
        check("host: found in a full-screen Space of its own: moved back, that Space destroyed (Mission Control lists Margin's only), still shown",
              e.shown == safari && w.inMargin == [mine] && w.tiles[space] == nil && w.listsMarginOnly && !events.contains(.unshown(safari)), "\(w.tiles.keys.sorted()) \(events)")
        // Out of full screen on its own (a normal window on the Desktop): back, and placed again as a first open places it.
        w.wins[mine]?.fullScreen = false
        w.wins[mine]?.member = false
        w.wins[mine]?.memberFrame = nil
        w.wins[mine]?.spaces = [FakeHostWorld.desktop]
        let loadings = said.loading.count
        e.poll()
        e.poll()
        settle()
        check("host: found on a Desktop and no longer at the frame it was placed at (it left full screen by itself): brought back and placed again (full screen, the page area), behind the loader, still shown",
              e.shown == safari && w.inMargin == [mine] && w.wins[mine]?.fullScreen == true && w.bounds(window: mine) == page && said.loading.count >= loadings + 2 && said.loading.last == .some(nil)
              && !events.contains(.unshown(safari)) && clean(w), "\(String(describing: w.bounds(window: mine))) \(said.loading.dropFirst(loadings)) \(events)")
        // Taken out again and again: parked after the third time in a row, nothing shown (said), not a loop.
        for _ in 0..<4 where e.shown == safari {
            w.wins[mine]?.spaces = [FakeHostWorld.desktop]
            e.poll()
            e.poll()
            settle()
        }
        check("host: taken out of Margin's Space again and again: brought back at most 3 times in 30 s, then parked with nothing shown (said)",
              e.shown == nil && e.hosts[safari]?.phase == .parked && events.contains(.unshown(safari)) && w.wins[mine]?.priv != nil, "\(events.suffix(4))")
    }

    // ---- a hosted window is never left in no Space (2026-11-17, check10 on the real Mac: about a second after a
    // placing the window was at its frame, in no Space, on no screen: the page area an empty hole) ----
    do {
        // The early path: its own Space destroyed only once the move into Margin's Space has shown and held, never in
        // the same breath. (The stand-in drops a window whose Space is destroyed within 30 ms of its move out.)
        let (w, e, _) = world()
        w.staged = true
        w.dropWithin = 0.03
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let r = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        let gap = (w.destroyedAt[own] ?? -1) - (w.movedOut[a]?.at ?? 0)
        hostRun { await w.sleep(1.0) }
        check("member: the early path: its own Space destroyed only once its move into Margin's Space had held (\(Int((gap * 1000).rounded())) ms after it, at least 50), never in the same breath",
              r == .shown(textEdit.id, placed: true) && gap >= 0.05 && w.movedOut[a]?.space == own, "\(gap) \(String(describing: r))")
        check("member: … a second later the window is still in Margin's Space, never dropped from it", w.drops == 0 && w.spaces(window: a) == [FakeHostWorld.marginSpace] && e.shown == textEdit.id && clean(w), "drops \(w.drops) \(String(describing: w.spaces(window: a)))")
        // A placing again, the same.
        let page2 = CGRect(x: 316, y: 41, width: 1188, height: 933)
        let ok = hostRun { await e.pageRectChanged(placed(page2)) }
        hostRun { await w.sleep(1.0) }
        check("member: … and after a placing again", ok == true && w.drops == 0 && w.spaces(window: a) == [FakeHostWorld.marginSpace] && w.bounds(window: a) == page2 && !events.contains(.unshown(textEdit.id)), "drops \(w.drops)")
    }
    do {
        // The destroy takes the window with it anyway, and it shows only after the first read said "in Margin's Space"
        // (as the real Mac's log: "in place" at +20 ms, in no Space later): in place only once it has stayed there;
        // found in none, put back; Margin's window told only then.
        let (w, e, _) = world()
        w.staged = true
        w.dropNext = 1
        w.dropAfter = 0.05
        var atShown: (drops: Int, spaces: [UInt64]?)?
        e.hostedWindow = { n in if n != nil, atShown == nil { atShown = (w.drops, w.spaces(window: n ?? 0)) } }
        let r = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit")
        hostRun { await w.sleep(1.0) }
        check("member: dropped from every Space by its own Space's destroy just after the first read: not in place yet; put back into Margin's Space, and shown (Margin's window told) only once it has stayed there",
              r == .shown(textEdit.id, placed: true) && w.drops == 1 && atShown?.drops == 1 && atShown?.spaces == [FakeHostWorld.marginSpace] && w.spaces(window: a) == [FakeHostWorld.marginSpace]
              && w.wins[a]?.fullScreen == true && w.bounds(window: a) == page && w.freezes == 1 && w.reveals == 1 && clean(w), "\(String(describing: r)) drops \(w.drops) at shown \(String(describing: atShown))")
    }
    do {
        // Moved in, and back in its own Space before that's destroyed (whatever put it there): moved in again, its Space
        // destroyed only then; still the early path.
        let (w, e, _) = world()
        w.staged = true
        w.rehomeAfter = 0.02
        let r = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit")
        let own = w.reserves.first?.space ?? 0
        let moves = w.calls.filter { $0 == "move \(a) \(FakeHostWorld.marginSpace)" }.count
        check("member: the early path: back in its own Space before the destroy: moved in again, its Space destroyed only then, still early (one freeze), in Margin's Space alone",
              r == .shown(textEdit.id, placed: true) && w.rehomes == 1 && moves == 2 && at(w, "destroy \(own)") > w.calls.lastIndex(of: "move \(a) \(FakeHostWorld.marginSpace)") ?? 99
              && w.freezes == 1 && w.reveals == 1 && w.destroyedWithWindows == 0 && w.spaces(window: a) == [FakeHostWorld.marginSpace] && w.bounds(window: a) == page && clean(w),
              "\(String(describing: r)) rehomes \(w.rehomes) moves \(moves) freezes \(w.freezes) \(w.calls.suffix(8))")
    }
    do {
        // The slow path (its window in a Space of its own first): the same after its destroy.
        let (w, e, _) = world()
        w.dropNext = 1
        w.dropAfter = 0.05
        var atShown: (drops: Int, spaces: [UInt64]?)?
        e.hostedWindow = { n in if n != nil, atShown == nil { atShown = (w.drops, w.spaces(window: n ?? 0)) } }
        let r = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit")
        check("member: the slow path: dropped by its own Space's destroy: put back, shown only once it has stayed in Margin's Space",
              r == .shown(textEdit.id, placed: true) && w.drops == 1 && atShown?.drops == 1 && atShown?.spaces == [FakeHostWorld.marginSpace] && w.spaces(window: a) == [FakeHostWorld.marginSpace] && clean(w),
              "\(String(describing: r)) drops \(w.drops) at shown \(String(describing: atShown))")
    }
    do {
        // Dropped later still (after it was shown): the poll's first read of the shown window in no Space brings it back.
        let (w, e, _) = world()
        w.staged = true
        w.dropNext = 1
        w.dropAfter = 0.6
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let said = watch(e)
        _ = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit")
        hostRun { await w.sleep(0.7) }
        let dropped = w.spaces(window: a) == [] && w.drops == 1
        e.poll()
        _ = hostRun { await e.activateShown(at: nil); return true }
        _ = hostRun { await e.pageRectChanged(placed(page)) } // (the next operation, after the poll's own)
        check("member: the shown window in no Space at all: brought back at the poll's first read (never a read that missed), still shown, never unshown or parked, Margin's window told its window again",
              dropped && e.shown == textEdit.id && w.spaces(window: a) == [FakeHostWorld.marginSpace] && w.bounds(window: a) == page && !events.contains(.unshown(textEdit.id))
              && !events.contains(.parked(textEdit.id)) && said.above.last == .some(a) && clean(w), "dropped \(dropped) \(String(describing: w.spaces(window: a))) \(events)")
        // Read in none, and back in Margin's Space by the time the engine gets to it (an operation in between, or a move
        // that was landing): nothing done, never parked.
        let before = w.calls.count
        w.wins[a]?.spaces = []
        e.poll()
        w.wins[a]?.spaces = [FakeHostWorld.marginSpace]
        _ = hostRun { await e.activateShown(at: nil); return true }
        _ = hostRun { await e.pageRectChanged(placed(page)) }
        check("member: read in no Space, in Margin's Space again by the time the engine gets to it: left alone (no move, never parked or unshown)",
              e.shown == textEdit.id && !w.calls[before...].contains { $0.hasPrefix("move") } && !events.contains(.unshown(textEdit.id)) && !events.contains(.parked(textEdit.id)), "\(w.calls[before...])")
        // In another Space (not none): still two reads.
        w.wins[a]?.spaces = [FakeHostWorld.desktop]
        e.poll()
        _ = hostRun { await e.activateShown(at: nil); return true }
        check("member: in another Space (not none): still not at the first read", w.spaces(window: a) == [FakeHostWorld.desktop] && e.shown == textEdit.id)
        w.wins[a]?.spaces = [FakeHostWorld.marginSpace]
    }
    do {
        // A switch: the private Space the window comes out of isn't destroyed as it leaves it (the first show of the
        // browser made ready at launch, 2026-11-17: shown, then "parked, nothing shown" 0.7 s later), but later, by
        // the poll; at Margin's quit, only once the last move out of one has settled.
        let (w, e, _) = world()
        e.options.privateRetire = 1.0
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, textEdit)
        _ = open(e, notes)
        let a = window(w, "com.apple.TextEdit"), b = window(w, "com.apple.Notes")
        hostRun { await w.sleep(1.0) }
        w.dropWithin = 0.5 // (from here: a Space destroyed within half a second of a move out of it takes the window)
        let t0 = w.clock
        let back = open(e, textEdit)
        let took = w.clock - t0
        let privatesAfter = w.privates.count
        hostRun { await w.sleep(0.6) }
        e.poll()
        _ = hostRun { await e.activateShown(at: nil); return true }
        check("member: a switch: the private Space its window came out of kept for now (not destroyed as it left), the switch as fast as ever (\(Int((took * 1000).rounded())) ms on the stand-in's clock); the window still in Margin's Space after",
              back == .shown(textEdit.id, placed: true) && took < 0.1 && privatesAfter == 2 && w.drops == 0 && w.spaces(window: a) == [FakeHostWorld.marginSpace] && e.shown == textEdit.id
              && !events.contains(.unshown(textEdit.id)), "took \(took) privates \(privatesAfter) drops \(w.drops)")
        hostRun { await w.sleep(0.6) }
        e.poll()
        _ = hostRun { await e.activateShown(at: nil); return true }
        _ = hostRun { await e.pageRectChanged(placed(page)) }
        check("member: … destroyed a second later by the poll (only Notes' own left), nothing dropped", w.privates.count == 1 && w.privates.first == w.wins[b]?.priv && w.drops == 0, "\(w.privates)")
        // Quit right after a switch: every window given back, the private Spaces destroyed only once the moves have settled.
        _ = open(e, notes)
        hostRun { await e.quitAll() }
        check("member: Margin's quit right after a switch: nothing dropped from every Space on its way back, no private Space left", w.drops == 0 && w.privates.isEmpty && w.apps.isEmpty && clean(w), "drops \(w.drops) \(w.privates)")
    }

    // ---- macOS's own full-screen change runs to its end (the real Mac, 2026-11-17, check10e/f) ----
    do {
        // The stand-in itself, as the real Mac did 4 times of 4: a window moved into Margin's Space as soon as it has
        // the page frame (before macOS brought it into its own Space), that Space destroyed: in place for now, and when
        // macOS's change comes to its end the window is in no Space and nothing of Margin's Space is on screen.
        let w = FakeHostWorld()
        w.staged = true
        w.autoOnScreen = true
        let p = w.start("com.apple.TextEdit", policy: .accessory, windows: 1)
        let n = w.apps[p]?.windows.first ?? 0
        let space = w.nextId
        hostRun {
            _ = await w.setFullScreen(pid: p, window: n, true)
            await w.sleep(0.05)
            _ = w.reserve(SlotEdges(left: 276, right: 8, top: 8, bottom: 8), space: space)
            await w.sleep(0.1)
            _ = w.move(window: n, to: FakeHostWorld.marginSpace)
            await w.sleep(0.05)
            _ = w.destroyFullScreenSpace(space)
            await w.sleep(0.1)
        }
        let inPlace = w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.bounds(window: n) == page && w.onScreenWindows()?.contains { $0.number == n } == true
        hostRun { await w.sleep(0.5) }
        check("stand-in: a window moved in on its page frame alone, before macOS brought it into its own Space: in place at first, then in no Space, nothing of Margin's Space on screen though it reads as the current one",
              inPlace && w.movedBeforeDelivery == 1 && w.lateDrops == 1 && w.spaces(window: n) == [] && w.current == FakeHostWorld.marginSpace && w.onScreenWindows() == [], "\(inPlace) \(w.lateDrops) \(String(describing: w.spaces(window: n)))")
    }
    do {
        // macOS never switches to the new Space (its switch is what ends its change): moved in a quarter of a second
        // after it brought the window into its Space.
        let (w, e, _) = world()
        w.staged = true
        w.jumpOnFullScreen = false
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let a = window(w, "com.apple.TextEdit")
        let moved = (w.movedOut[a]?.at ?? 0) - (w.askedAt[a] ?? 0)
        check("early: no switch by macOS after its window is in its own Space: moved in 250 ms after that (\(Int((moved * 1000).rounded())) ms after the ask), said, still early",
              r == .shown(textEdit.id, placed: true) && moved >= 0.775 && moved < 0.8 && w.movedBeforeDelivery == 0 && w.lateDrops == 0 && lines.contains { $0.contains("full screen by the early path") && $0.contains("no switch by macOS") }
              && w.bounds(window: a) == page && clean(w), "\(moved) \(lines.filter { $0.contains("early") })")
    }
    do {
        // macOS never brings the window into its own Space within the early path's wait: nothing moved, the slow path
        // takes it from there.
        let (w, e, _) = world()
        w.staged = true
        w.stageMember = 1.8
        w.stageEnter = 1.9
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let r = open(e, textEdit)
        Diagnostics.echo = echo
        let a = window(w, "com.apple.TextEdit")
        check("early fallback: its window page-sized but not brought into its own Space by macOS within 1.5 s: never moved before it was, the slow path takes it from its own Space",
              r == .shown(textEdit.id, placed: true) && w.movedBeforeDelivery == 0 && w.lateDrops == 0 && w.bounds(window: a) == page && w.freezes == w.reveals
              && lines.contains { $0.contains("fell back") && $0.contains("didn't bring its window into its own Space") } && clean(w), "\(lines.filter { $0.contains("early") })")
    }
    do {
        // After the engine is done: macOS makes a Space current that wasn't listed before the ask (a late step of its own
        // change): undone at the poll's read for 3 s after the ask; a Space the person had, or a Desktop, never.
        let (w, e, _) = world()
        w.staged = true
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        _ = open(e, textEdit)
        hostRun { await w.sleep(0.5) }
        w.calls = []
        w.current = 4242
        e.poll()
        let undone = w.current == FakeHostWorld.marginSpace && w.calls == ["current \(FakeHostWorld.marginSpace)"]
        w.current = FakeHostWorld.desktop
        e.poll()
        let desktopLeft = w.current == FakeHostWorld.desktop
        w.current = FakeHostWorld.marginSpace
        hostRun { await w.sleep(3) }
        w.calls = []
        w.current = 4243
        e.poll()
        Diagnostics.echo = echo
        check("late: a Space made current by macOS within 3 s of the full-screen ask, once the engine was done: Margin's Space current again at the poll's read, said; a Desktop the person went to left alone; later than 3 s: not the engine's to undo",
              undone && desktopLeft && w.current == 4243 && w.calls.isEmpty && lines.filter { $0.contains("after a full-screen ask, once the engine was done") }.count == 1, "\(undone) \(desktopLeft) \(w.calls) \(lines.suffix(3))")
        w.current = FakeHostWorld.marginSpace
    }

    // ---- the poll looks at the window server's on-screen list too (2026-11-17: every Space read looked right from
    // inside Margin while neither the hosted window nor Margin's own was on screen) ----
    do {
        let (w, e, _) = world()
        w.staged = true
        w.autoOnScreen = true
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        _ = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit")
        func settle() { _ = hostRun { await e.activateShown(at: nil); return true }; _ = hostRun { await e.pageRectChanged(placed(page)) } }
        e.poll(); settle()
        let quiet = w.calls.count
        check("on screen: both windows on screen: nothing done, nothing said", !lines.contains { $0.contains("not on screen") || $0.contains("host: poll:") }, "\(lines.suffix(3))")
        // Nothing of Margin's Space on screen, the Spaces reads as they should be: the second read in a row acts.
        w.blank = true
        e.poll(); settle()
        let first = !w.calls[quiet...].contains { $0.hasPrefix("current") || $0.hasPrefix("move") }
        e.poll(); settle()
        check("on screen: neither window on screen though every Space read is right: left at the first read, at the second Margin's Space made current again and the window moved into it again: on screen, still shown, never parked",
              first && w.calls[quiet...].contains("current \(FakeHostWorld.marginSpace)") && w.calls[quiet...].contains("move \(a) \(FakeHostWorld.marginSpace)") && !w.calls[quiet...].contains { $0.hasPrefix("fullScreen") }
              && !w.blank && e.shown == textEdit.id && !events.contains(.unshown(textEdit.id)) && !events.contains(.parked(textEdit.id)), "\(first) \(w.calls[quiet...])")
        check("on screen: said with what the window server had: both windows, their Spaces, each display's current Space",
              lines.contains { $0.contains("shown, not on screen (Margin's window off screen, its window \(a) off screen and in [\(FakeHostWorld.marginSpace)]") && $0.contains("the displays' current Spaces \(FakeHostWorld.marginSpace) (not listed)") }
              && lines.contains { $0.contains("on screen again in") } && lines.contains { $0.contains("host: poll: \(textEdit.id): shown") && $0.contains("Margin's window off screen") }, "\(lines.filter { $0.contains("screen") })")
        // That doesn't bring it back: out of full screen and placed again (what did on the real Mac).
        w.blankUntilPlaced = true
        w.blank = true
        let mark = w.calls.count
        e.poll(); settle()
        e.poll(); settle()
        check("on screen: not back by that: out of full screen and placed again behind the loader, on screen then, still shown",
              w.calls[mark...].contains("fullScreen false \(a)") && w.calls[mark...].contains("fullScreen true \(a)") && !w.blank && w.onScreenWindows()?.contains { $0.number == a } == true
              && e.shown == textEdit.id && w.bounds(window: a) == page && !events.contains(.unshown(textEdit.id)) && clean(w), "\(w.calls[mark...])")
        w.blankUntilPlaced = false
        // Not the engine's business: the screen locked or asleep, the person on another Space, its app hidden.
        hostRun { await w.sleep(4) }
        let before = w.calls.count
        w.blank = true
        w.away = true
        e.poll(); settle(); e.poll(); settle()
        w.away = false
        w.current = FakeHostWorld.desktop
        e.poll(); settle(); e.poll(); settle()
        w.current = FakeHostWorld.marginSpace
        w.blank = false
        w.hidden.insert(pid(w, "com.apple.TextEdit"))
        e.poll(); settle(); e.poll(); settle()
        w.hidden = []
        check("on screen: the screen locked or asleep, the person on another Space, the hosted app hidden: never acted on", !w.calls[before...].contains { $0.hasPrefix("current") || $0.hasPrefix("move") || $0.hasPrefix("fullScreen") }, "\(w.calls[before...])")
        // Its window alone missing long after its show (minimized by its app or the person): said, left alone.
        w.minimized = [a]
        e.poll(); settle(); e.poll(); settle(); e.poll(); settle()
        check("on screen: the hosted window alone off screen long after its show (its app's doing: minimized): said by the poll, left alone",
              !w.calls[before...].contains { $0.hasPrefix("current") || $0.hasPrefix("move") || $0.hasPrefix("fullScreen") } && e.shown == textEdit.id
              && lines.contains { $0.contains("host: poll: \(textEdit.id): shown") && $0.contains("Margin's window on screen, its window off screen") }, "\(w.calls[before...]) \(lines.suffix(2))")
        w.minimized = []
        e.poll(); settle()
        check("on screen: back: said once", lines.filter { $0.contains("as it should be again") }.count >= 1)
        // Right after a show, the hosted window alone missing (in Margin's Space, the current one, Margin's window on
        // screen): at the second read, never the first; no Space made current, nothing moved by the look; placed again,
        // 3 times at most in 30 s, then left as it is (said once).
        let moved = placed(CGRect(x: 316, y: 41, width: 1188, height: 933))
        func barrier() { _ = hostRun { await e.pageRectChanged(moved) } } // (the page area as it is: nothing placed, the poll's work waited for)
        barrier()
        w.minimized = [a]
        let again = w.calls.count, saidBefore = lines.count
        e.poll(); barrier()
        let notFirst = !w.calls[again...].contains { $0.hasPrefix("fullScreen") || $0.hasPrefix("current") || $0.hasPrefix("move") }
        for _ in 0..<14 { e.poll(); barrier() }
        let placings = w.calls[again...].filter { $0 == "fullScreen true \(a)" }.count
        let after = lines[saidBefore...]
        Diagnostics.echo = echo
        check("on screen: right after a show, the hosted window alone missing in Margin's Space (the current one): not at the first read; no Space made current, nothing moved by the look; placed again 1 to 3 times in 30 s, then left as it is (said once), still hosted",
              notFirst && placings >= 1 && placings <= 3 && !after.contains { $0.contains("Margin's Space made current again") || $0.contains("moved into it again") }
              && after.filter { $0.contains("no Space made current, nothing moved") }.count == placings && after.filter { $0.contains("left as it is") }.count == 1
              && e.hosts[textEdit.id] != nil, "\(notFirst) \(placings) \(after.filter { $0.contains("not on screen") })")
        w.minimized = []
    }

    // ---- another window in Margin's Space: let in front only when it's the shown app's, there at rest, twice ----
    do {
        let (w, e, _) = world()
        var others: [Int?] = []
        e.others = { others.append($0) }
        var reads: [HostEngine.FrontRead] = []
        e.front = { reads.append($0) }
        // (What's on screen as the app opens: a window its app made beside its full-screen one, reaching over Margin's frame.)
        w.onScreen = []
        _ = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit"), editPid = pid(w, "com.apple.TextEdit")
        w.clock += e.options.lateWatch // (past the opening's late watch: a Space change below is the stand-in's alone, never undone by it)
        let margin = ServerWindow(number: FakeHostWorld.marginWindow, pid: 1, layer: 1, bounds: FakeHostWorld.display)
        let hostedNow = ServerWindow(number: a, pid: editPid, bounds: page)
        func polls(_ n: Int) { for _ in 0..<n { w.clock += 0.25; e.poll() } }
        func list(_ extra: [ServerWindow]) { w.onScreen = [margin] + extra + [hostedNow]; for x in extra { w.serverSpaces[x.number] = w.serverSpaces[x.number] ?? [FakeHostWorld.marginSpace] } }
        let toolbar = ServerWindow(number: 900, pid: editPid, bounds: CGRect(x: 276, y: -11, width: 1228, height: 90))
        list([toolbar])
        polls(3)
        check("host: a window of a hosted app that came during its opening (first seen right after it): never let in front of Margin's window", others.isEmpty, "\(others)")
        let settings = ServerWindow(number: 901, pid: editPid, bounds: CGRect(x: 300, y: 20, width: 600, height: 400)) // (reaching above the page area, never over the sidebar: one over it is never let in front)
        list([settings, toolbar])
        polls(1)
        check("host: the shown app's window the person opened (its Settings), seen at one poll: not let in front yet (a Space change's picture lasts one read)", others.isEmpty, "\(others)")
        polls(1)
        check("host: ...seen again at the next poll, 250 ms later, in Margin's Space alone by its own Space read: let in front", others == [901], "\(others)")
        polls(1)
        check("host: … said once while it's there", others == [901])
        // A Space change under way while it's there (the display's current Space another one by the read after the
        // list): nothing said, kept; at rest again: still kept, never let go and taken again.
        w.onScreenRead = { w.current = 777 }
        polls(1)
        w.onScreenRead = nil
        w.current = FakeHostWorld.marginSpace
        polls(1)
        check("host: a Space change under way while it's let in front: nothing said, and at rest again still let in front (no flap)", others == [901], "\(others)")
        let inside = ServerWindow(number: 902, pid: editPid, bounds: CGRect(x: 500, y: 300, width: 500, height: 300))
        list([inside, toolbar])
        polls(1)
        check("host: gone: Margin's window in front again; a window wholly inside the page area needs nothing (it shows through the hole, its clicks its own)", others == [901, nil], "\(others)")
        let panel = ServerWindow(number: 903, pid: editPid, layer: 3, bounds: CGRect(x: 300, y: 20, width: 600, height: 400))
        let tiny = ServerWindow(number: 904, pid: editPid, bounds: CGRect(x: 300, y: 20, width: 60, height: 40))
        let unseen = ServerWindow(number: 905, pid: editPid, bounds: CGRect(x: 300, y: 20, width: 600, height: 400), alpha: 0)
        let own = ServerWindow(number: 906, pid: 1, bounds: CGRect(x: 300, y: 20, width: 600, height: 400))
        list([panel, tiny, unseen, own])
        polls(3)
        check("host: never for a panel above normal windows (it's above Margin's already), a tiny or see-through window, or one of Margin's own", others == [901, nil], "\(others)")
        // (2026-11-17, his log: his own Claude app's and Arc's full-screen windows, each in its own Space, in the
        // on-screen list as he swiped, the display still saying Margin's Space.)
        let swipedTo = ServerWindow(number: 12315, pid: 4321, bounds: FakeHostWorld.display)
        w.serverSpaces[12315] = [555]
        list([swipedTo])
        polls(4)
        check("host: a Space swipe: another app's full-screen window (not hosted, in its own Space by its Space read) in the on-screen list while the current Space reads Margin's: never let in front", others == [901, nil], "\(others)")
        let stranger = ServerWindow(number: 907, pid: 4321, bounds: CGRect(x: 60, y: 100, width: 700, height: 500))
        list([stranger])
        polls(4)
        check("host: an app Margin doesn't host, its window in Margin's Space by every read, poll after poll: never let in front (such an app can't put a normal window in another app's full-screen Space)", others == [901, nil], "\(others)")
        let elsewhere = ServerWindow(number: 909, pid: editPid, bounds: CGRect(x: 300, y: 20, width: 600, height: 400))
        w.serverSpaces[909] = [FakeHostWorld.marginSpace, 555]
        list([elsewhere])
        polls(4)
        check("host: the shown app's window in another Space too by its own Space read: never let in front", others == [901, nil], "\(others)")
        let late = ServerWindow(number: 910, pid: editPid, bounds: CGRect(x: 300, y: 20, width: 600, height: 400))
        list([late])
        w.onScreenRead = { w.current = 777 }
        for _ in 0..<4 { polls(1); w.current = FakeHostWorld.marginSpace }
        w.onScreenRead = nil
        check("host: the shown app's window in Margin's Space, but the display's current Space another one right after each list read (a Space change): never let in front", others == [901, nil], "\(others)")
        polls(2)
        check("host: ...and at rest, at two polls: let in front", others == [901, nil, 910], "\(others)")
        list([])
        polls(1)
        check("host: ...gone: in front again", others == [901, nil, 910, nil], "\(others)")
        // The poll's front read: at rest only, what the list has of Margin's window and the one shown.
        let atRest = reads.last
        w.onScreen = [hostedNow, margin]
        polls(1)
        let wrong = reads.last, count = reads.count
        w.onScreen = [margin, hostedNow]
        w.onScreenRead = { w.current = 777 }
        polls(1)
        w.onScreenRead = nil
        w.current = FakeHostWorld.marginSpace
        w.onScreen = [hostedNow]
        polls(1)
        check("host: the poll's front read at rest: Margin's window's layer and whether it's above the one shown, by the on-screen order; none during a Space change or without Margin's window in the list",
              atRest == HostEngine.FrontRead(hosted: a, marginLayer: 1, marginAbove: true) && wrong == HostEngine.FrontRead(hosted: a, marginLayer: 1, marginAbove: false) && reads.count == count,
              "\(String(describing: atRest)) \(String(describing: wrong)) \(reads.count - count)")
        // A second app shown, the first parked: a window the parked one makes now isn't the person's doing.
        _ = open(e, notes)
        let b = window(w, "com.apple.Notes"), notesPid = pid(w, "com.apple.Notes")
        let notesNow = ServerWindow(number: b, pid: notesPid, bounds: page)
        w.onScreen = [margin, notesNow]
        polls(1)
        let parkedOne = ServerWindow(number: 908, pid: editPid, bounds: CGRect(x: 300, y: 20, width: 600, height: 400))
        w.serverSpaces[908] = [FakeHostWorld.marginSpace]
        w.onScreen = [margin, parkedOne, notesNow]
        polls(4)
        check("host: a window of a hosted app that isn't the one shown (parked: out of sight, the person can't have opened it): never let in front", others == [901, nil, 910, nil], "\(others)")
        w.onScreen = [margin, notesNow]
        w.current = FakeHostWorld.desktop
        polls(2)
        check("host: Margin's Space not the current one: nothing to let in front, nothing said", others == [901, nil, 910, nil], "\(others)")
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
    refusedFullScreenTests(world: world)
    session1405Tests(world: world)

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
        e.hostedWindow = { h.above.append($0) }
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
        check("window mode: Margin's window kept below it (keepAbove its number), its app in front", h.above == [n] && e.shownWindow == n && w.calls.last == "activate \(p) \(n)", "\(h.above)")
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
        check("window mode → full screen: FaceTime parked in a private Space as it is, at the page area's frame (its frame is given back only with it: no frame set, no full-screen exit)",
              w.wins[n]?.frame == page2 && w.wins[n]?.priv != nil && !w.calls.contains { $0.hasPrefix("frame \(n) ") } && !w.calls.contains("fullScreen false \(n)"), "\(w.calls)")
        check("window mode → full screen: Margin's window kept below TextEdit now", h.above.last == .some(tw) && e.shownWindow == tw, "\(h.above)")
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
              r == .failed(.window, "Accessibility doesn't list its window, even on the current Space or with its Desktop current, nor once its app was brought forward") && w.running(bundleId: "com.apple.calculator").isEmpty
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
        check("window mode: a press in the page area around it: its app given the keyboard (made the front app, its window raised)", w.calls == ["frontmost \(p)", "activate \(p) \(n)"], "\(w.calls)")
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
        // An app that doesn't quit within 5 s, its row closed: left running, and the log says what can be read of why.
        let (w, e, _) = world()
        _ = wired(e)
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime")
        w.apps[p]?.refusesQuit = true
        w.serverExtra = [ServerWindow(number: 9001, pid: p, layer: 8, bounds: CGRect(x: 600, y: 400, width: 300, height: 160))] // (an alert of its own)
        let lines = said { hostRun { await e.close(faceTime.id); await w.sleep(6) }; e.poll(); hostRun { await w.sleep(0.1) } } // (not waited for: the poll says it 6 s later)
        check("window mode: an app that doesn't quit within 6 s (its row closed): asked politely once, left running, the log says why it may be",
              w.calls.filter { $0 == "terminate \(p)" }.count == 1 && w.apps[p] != nil && e.launched[p] != nil && e.exitingPids.isEmpty
              && lines.contains { $0.contains("didn't quit within 6 s (still no Dock icon; 1 other window of its own on screen (it may be asking something); Accessibility still answers for it)") },
              "\(lines.filter { $0.contains("quit") })")
    }
    // ---- a row closed while Margin keeps running: given back as Margin's quit does it, its app asked once and
    // forgotten at once, the queue released; its exit heard in the background (Maps, 2026-11-16: its own 5 s watchdog
    // held the queue, and every open or switch meanwhile) ----
    for keeps in [false, true] {
        let (w, e, marker) = world()
        _ = wired(e)
        if keeps { w.keepsWindows = ["com.apple.Notes"] } // (never closed first: taken home instead)
        _ = open(e, textEdit)
        _ = open(e, notes) // (shown; TextEdit parked)
        let np = pid(w, "com.apple.Notes"), nn = window(w, "com.apple.Notes")
        w.quitsAfter["com.apple.Notes"] = 5 // (Maps: out only after its own 5 s watchdog)
        w.calls = []
        var lines: [String] = []
        let r = hostRun { () -> (Double, Bool) in
            let t0 = w.clock
            let echo = Diagnostics.echo
            Diagnostics.echo = { lines.append($0) }
            await e.close(notes.id)
            Diagnostics.echo = echo
            return (w.clock - t0, w.apps[np] != nil)
        }
        let took = r?.0 ?? 99
        let how = keeps ? "kept windows: taken home" : "closed first"
        check("row closed (\(how)): returned without waiting for its exit (\(Int(took * 1000)) ms), the app still finishing, asked once, forgotten at once",
              took < 1 && r?.1 == true && w.calls.filter { $0 == "terminate \(np)" }.count == 1 && e.hosts[notes.id] == nil && e.launched[np] == nil && e.exitingPids == [np]
              && lines.contains { $0.contains("com.apple.Notes closed (closed)") && $0.contains("asked to quit") }, "\(took) \(w.calls) \(lines)")
        check("row closed (\(how)): given back as Margin's quit does it, before the ask (\(keeps ? "on its Desktop, out of full screen" : "its close button"))",
              keeps ? (w.spaces(window: nn) == [FakeHostWorld.desktop] && w.wins[nn]?.fullScreen == false && !w.calls.contains("close \(nn)") && last(w, "move \(nn) \(FakeHostWorld.desktop)") < at(w, "terminate \(np)"))
                    : (at(w, "close \(nn)") >= 0 && at(w, "close \(nn)") < at(w, "terminate \(np)") && w.wins[nn] == nil),
              "\(w.calls)")
        check("row closed (\(how)): nothing of it in Margin's Spaces or a private one (TextEdit's only), the marker has the app as asked", !w.inMargin.contains(nn) && w.wins[nn]?.priv == nil && w.privates.count == 1 && clean(w)
              && HostMarker.read(marker)?.apps.contains { $0.pid == np && $0.quitAsked == true } == true, "\(w.inMargin) \(w.privates) \(String(describing: HostMarker.read(marker)))")
        // A switch right after: never behind that exit.
        let t1 = w.clock
        let s = hostRun { await e.show(textEdit.id) }
        check("row closed (\(how)): a switch right after isn't delayed (\(Int((w.clock - t1) * 1000)) ms), Notes still finishing", s == .shown(textEdit.id, placed: true) && w.clock - t1 < 1 && w.apps[np] != nil, "\(String(describing: s)) \(w.clock - t1)")
        // Its exit heard in the background: out of the marker, said.
        let heard = said { hostRun { await w.sleep(5) } }
        check("row closed (\(how)): its exit heard later, out of the marker, said", w.apps[np] == nil && e.exitingPids.isEmpty && HostMarker.read(marker)?.apps.contains { $0.pid == np } != true
              && heard.contains { $0.contains("com.apple.Notes (pid \(np)) quit") }, "\(heard) \(String(describing: HostMarker.read(marker)))")
        hostRun { await e.quitAll() }
        check("row closed (\(how)): Margin's quit after it asks only TextEdit", w.calls.filter { $0 == "terminate \(np)" }.count == 1 && w.apps.values.allSatisfy { $0.bundle != "com.apple.TextEdit" })
    }
    do {
        // The same app opened again while its old instance is still finishing: that exit waited for, a new one started
        // (the dying one never hosted, nor taken for the person's).
        let (w, e, _) = world()
        _ = wired(e)
        _ = open(e, notes)
        let old = pid(w, "com.apple.Notes")
        w.quitsAfter["com.apple.Notes"] = 5
        hostRun { await e.close(notes.id) }
        w.quitsAfter = [:]
        check("reopen during its exit: (the old instance still finishing)", w.apps[old] != nil && e.exitingPids == [old])
        let lines = said { _ = open(e, notes) }
        let now = pid(w, "com.apple.Notes")
        check("reopen during its exit: waited for the old instance's exit, then a new one started and hosted as Margin's",
              e.isHosted(notes.id) && e.shown == notes.id && w.apps[old] == nil && now != old && now != 0 && e.launched[now] != nil && e.exitingPids.isEmpty
              && w.calls.filter { $0 == "launch com.apple.Notes" }.count == 2 && lines.contains { $0.contains("its last instance's exit waited for") }, "\(w.calls.suffix(12)) \(lines.filter { $0.contains("Notes") })")
        hostRun { await e.quitAll() }
        check("reopen during its exit: nothing left", w.apps.isEmpty && clean(w))
    }
    do {
        // ...and an old instance that doesn't quit (unsaved work): after `quitWait` it's Margin's again, reused (no
        // second launch), said once.
        let (w, e, _) = world()
        _ = wired(e)
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, notes)
        let old = pid(w, "com.apple.Notes")
        w.apps[old]?.refusesQuit = true
        hostRun { await e.close(notes.id) }
        let r = open(e, notes)
        check("reopen of one that doesn't quit: Margin's again after 6 s, reused (never launched twice), said",
              r == .shown(notes.id, placed: true) && pid(w, "com.apple.Notes") == old && e.launched[old] != nil && e.exitingPids.isEmpty
              && w.calls.filter { $0 == "launch com.apple.Notes" }.count == 1 && events.contains { if case .failed(_, .quit, _) = $0 { return true }; return false }, "\(String(describing: r)) \(events)")
        w.apps[old]?.refusesQuit = false
        hostRun { await e.quitAll() }
        check("reopen of one that doesn't quit: Margin's quit asks it again", w.apps[old] == nil && clean(w))
    }
    do {
        // Margin quits while a row's app is still finishing: not asked again, kept in the marker as asked; the next
        // launch asks again only if that same launch still runs.
        let (w, e, marker) = world()
        _ = wired(e)
        _ = open(e, notes)
        let old = pid(w, "com.apple.Notes")
        w.apps[old]?.refusesQuit = true
        hostRun { await e.close(notes.id) }
        hostRun { await e.quitAll() }
        let m = HostMarker.read(marker)
        check("Margin quits while a row's app finishes: asked once only, in the marker as asked", w.calls.filter { $0 == "terminate \(old)" }.count == 1 && m?.apps.map(\.pid) == [old] && m?.apps.first?.quitAsked == true,
              "\(w.calls) \(String(describing: m))")
        w.apps[old]?.refusesQuit = false
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        check("Margin quits while a row's app finishes: the next launch asks it again, the marker gone", w.calls.filter { $0 == "terminate \(old)" }.count == 2 && w.apps[old] == nil && !FileManager.default.fileExists(atPath: marker.path))
    }
    do {
        // ...the same at Margin's quit: asked once, never waited for; its window on its Desktop (not a private Space that
        // goes with Margin), at its own frame; the app in the marker as asked, so the next launch asks again.
        let (w, e, marker) = world()
        _ = wired(e)
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime"), n = window(w, "com.apple.FaceTime")
        w.apps[p]?.refusesQuit = true
        let t0 = w.clock
        let lines = said { hostRun { await e.quitAll() } }
        let took = w.clock - t0
        let m = HostMarker.read(marker)
        check("Margin quits, an app that doesn't quit: asked once, not waited for (\(Int(took * 1000)) ms), its window on its Desktop at its own frame",
              took < 1 && w.calls.filter { $0 == "terminate \(p)" }.count == 1 && w.apps[p] != nil && w.spaces(window: n) == [FakeHostWorld.desktop] && w.wins[n]?.frame == original
              && !lines.contains { $0.contains("didn't quit") } && lines.contains { $0.contains("still quitting on their own, not waited for: com.apple.FaceTime") },
              "\(took) \(w.calls) \(lines.filter { $0.contains("quit") })")
        check("Margin quits, an app that doesn't quit: the marker has it as asked, nothing else", m?.apps.map(\.pid) == [p] && m?.apps.first?.quitAsked == true && m?.windows.isEmpty == true && m?.marginSpace == nil,
              "\(String(describing: m))")
        // The next launch: that same launch still running is asked again (and still says no), the marker gone.
        let next = HostEngine(system: w, marker: marker, pid: 2)
        w.calls = []
        let again = said { hostRun { await next.recover() } }
        check("Margin quits, an app that doesn't quit: the next launch asks it again, says so, the marker gone",
              w.calls.contains("terminate \(p)") && !FileManager.default.fileExists(atPath: marker.path) && again.contains { $0.contains("1 app asked to quit at Margin's last quit: 1 still running") }, "\(w.calls) \(again)")
    }

    // ---- an app Margin quits: its window closed first whenever that's harmless for its next launch (it doesn't keep
    // its windows across a quit: macOS's default), so an iPad app's own quit doesn't wait out its 5 s watchdog
    // (2026-11-15: parked, given back to its Desktop, then asked to quit: 5 s, and its 561 read as a promotion) ----
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
        // Its close button not taking (a sheet, Accessibility refusing): asked to quit with its window open (on its
        // Desktop), not waited for; its 561 (a background app now, as it quits) not taken for a promotion; out after its
        // own watchdog, on its own.
        let (w, e, _) = world()
        _ = wired(e)
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime"), n = window(w, "com.apple.FaceTime")
        w.fail = ["close"]
        let t0 = w.clock
        let lines = said { hostRun { await e.quitAll() } }
        let took = w.clock - t0
        check("iPad app at quit, its close refused: asked to quit with its window open on its Desktop, not waited for (\(Int(took * 1000)) ms), its type change not a promotion",
              took < 1 && w.calls.contains("terminate \(p)") && w.apps[p] != nil && w.spaces(window: n) == [FakeHostWorld.desktop] && !events.contains(.promoted(faceTime.id))
              && lines.contains { $0.contains("its type changed (LaunchServices 561), now a background app, as it quits: not a Dock app") } && !lines.contains { $0.contains("didn't quit") },
              "\(took) \(events) \(lines.filter { $0.contains("FaceTime") })")
        hostRun { await w.sleep(5.1) }
        check("iPad app at quit, its close refused: out by its own watchdog after Margin's quit; its frame still its own", w.apps[p] == nil && w.saved["com.apple.FaceTime"] == original && w.frameAtQuit["com.apple.FaceTime"] == original)
    }
    // How the order affects the app's own exit, measured on the stand-in (an iPad app's quit as its logs show it): its
    // window closed first, out at once; kept (it keeps its windows across a quit: never closed first, taken home), out
    // after its own 5 s watchdog. Margin's quit takes well under a second either way: it never waits for the exit.
    var exits: [String: Double] = [:]
    for keeps in [false, true] {
        let (w, e, _) = world()
        _ = wired(e)
        _ = open(e, faceTime)
        let p = pid(w, "com.apple.FaceTime"), n = window(w, "com.apple.FaceTime")
        if keeps { w.keepsWindows = ["com.apple.FaceTime"] }
        let t0 = w.clock
        hostRun { await e.quitAll() }
        let took = w.clock - t0
        var out = w.apps[p] == nil ? 0.0 : -1
        while w.apps[p] != nil, w.clock - t0 < 10 { hostRun { await w.sleep(0.01) } }
        if out < 0 { out = w.clock - t0 }
        exits[keeps ? "kept" : "closed first"] = out
        check("close-first rule (\(keeps ? "keeps its windows: never closed, taken home" : "macOS's default: closed first")): Margin's quit \(Int(took * 1000)) ms, the app out \(Int(out * 1000)) ms after it",
              took < 1 && (keeps ? !w.calls.contains("close \(n)") && at(w, "move \(n) \(FakeHostWorld.desktop)") < at(w, "terminate \(p)") && at(w, "move \(n) \(FakeHostWorld.desktop)") >= 0 && out >= 5
                         : at(w, "close \(n)") >= 0 && at(w, "close \(n)") < at(w, "terminate \(p)") && out < 0.1), "\(w.calls)")
    }
    print("  (close-first rule, an iPad app's own exit after it's asked: closed first \(Int((exits["closed first"] ?? -1) * 1000)) ms, kept \(Int((exits["kept"] ?? -1) * 1000)) ms)")
    for keeps in [false, true] {
        // An AppKit app (Calculator) by the same rule: closed first unless it keeps its windows across a quit (then the
        // window it would reopen is never closed: taken home, asked to quit with it open).
        let (w, e, _) = world()
        _ = wired(e)
        _ = open(e, calculator)
        let p = pid(w, "com.apple.calculator"), n = window(w, "com.apple.calculator")
        if keeps { w.keepsWindows = ["com.apple.calculator"] }
        hostRun { await e.quitAll() }
        check("an AppKit app at quit (\(keeps ? "keeps its windows" : "macOS's default")): \(keeps ? "never closed first, taken home, asked to quit with it open" : "its window closed first, its frame its own, then asked to quit")",
              w.calls.contains("terminate \(p)") && w.apps[p] == nil && w.saved["com.apple.calculator"] == CGRect(x: 400, y: 300, width: 230, height: 408)
              && (keeps ? !w.calls.contains { $0.hasPrefix("close ") } && at(w, "move \(n) \(FakeHostWorld.desktop)") >= 0 : at(w, "close \(n)") >= 0 && at(w, "close \(n)") < at(w, "terminate \(p)")), "\(w.calls)")
    }

    // ---- Margin's quit: every host given back at once, no app's exit waited for ----
    do {
        // TextEdit and Notes full screen (one shown, one parked), FaceTime and Calculator in window mode, the person's
        // Phone, a Safari window a copy made; the window server's bounds 300 ms late (each window-mode frame given back
        // takes that: parked at the page area's frame, each is given back at the quit), Notes slow to finish its quit (3 s), Calculator's 5 s: the quit is the slowest host's time.
        let (w, e, marker) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 0)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = wired(e)
        let phonePid = w.start("com.apple.mobilephone", policy: .regular, windows: 1)
        let phoneWindow = w.apps[phonePid]!.windows[0]
        let phoneFrame = w.wins[phoneWindow]?.frame ?? FakeHostWorld.defaultFrame
        for t in [faceTime, calculator, notes, textEdit, phone] { _ = open(e, t) }
        _ = open(e, .safariWindow(nil))
        _ = open(e, textEdit)
        w.frameLag = 0.3
        w.moveLag = 0.1 // (each move the bridge makes lands 100 ms late: every host's give-back takes a while)
        w.quitsAfter = ["com.apple.Notes": 3, "com.apple.calculator": 5]
        let started = Dictionary(uniqueKeysWithValues: ["com.apple.FaceTime", "com.apple.calculator", "com.apple.Notes", "com.apple.TextEdit"].map { ($0, pid(w, $0)) })
        check("at once: (six hosts, TextEdit shown)", e.hosts.count == 6 && e.shown == textEdit.id, "\(e.hosts.keys)")
        w.calls = []
        let t0 = w.clock
        let lines = said { hostRun { await e.quitAll() } }
        let took = w.clock - t0
        let each = lines.compactMap { line -> Int? in
            guard line.contains("closed (Margin quits) in "), let r = line.range(of: "closed (Margin quits) in ") else { return nil }
            return Int(line[r.upperBound...].prefix { $0.isNumber })
        }
        // (Interleaved: by the second app's ask to quit, at least three hosts' windows had steps of theirs done.)
        let terminates = w.calls.indices.filter { w.calls[$0].hasPrefix("terminate") }
        let second = terminates.count > 1 ? terminates[1] : 0
        let touched = Set(w.calls[..<second].compactMap { c -> String? in
            let parts = c.split(separator: " ")
            guard ["move", "close", "fullScreen", "frame"].contains(String(parts[0])), parts.count >= 3 else { return nil }
            return String(parts[0] == "move" ? parts[1] : parts[2])
        })
        print("  (Margin's quit with six hosts: \(Int(took * 1000)) ms; each host's give-back \(each) ms, \(each.reduce(0, +)) ms one after another)")
        check("at once: the quit in \(Int(took * 1000)) ms, about the slowest host's (\(each.max() ?? -1) ms), not their sum (\(each.reduce(0, +)) ms)",
              took < 0.6 && each.count == 6 && Double(each.reduce(0, +)) > took * 1000 * 1.5 && Double(each.max() ?? 0) >= took * 1000 - 30, "\(each) \(took)")
        check("at once: the hosts' steps interleaved (\(touched.count) windows had steps done by the second app's ask to quit)", touched.count >= 3, "\(w.calls)")
        check("at once: no app's exit waited for: Notes and Calculator still quitting as it ends, said; TextEdit and FaceTime out",
              w.apps[started["com.apple.Notes"]!] != nil && w.apps[started["com.apple.calculator"]!] != nil && w.apps[started["com.apple.TextEdit"]!] == nil && w.apps[started["com.apple.FaceTime"]!] == nil
              && lines.contains { $0.contains("still quitting on their own, not waited for: com.apple.Notes, com.apple.calculator") }, "\(lines.filter { $0.contains("quit:") })")
        check("at once: every window where it belongs: Notes' and Calculator's on their Desktop (closed first: none open), Phone back at its frame running, Safari's closed by its copy, no private Space, nothing left",
              w.apps[phonePid] != nil && w.spaces(window: phoneWindow) == [FakeHostWorld.desktop] && w.wins[phoneWindow]?.frame == phoneFrame && copy.closed.count == 1
              && w.privates.isEmpty && clean(w) && w.inMargin.isEmpty && w.freezes == w.reveals, "\(w.calls)")
        let m = HostMarker.read(marker)
        check("at once: the marker has only the apps still quitting, as asked", Set(m?.apps.map(\.bundleId) ?? []) == ["com.apple.Notes", "com.apple.calculator"] && m?.apps.allSatisfy { $0.quitAsked == true } == true && m?.windows.isEmpty == true,
              "\(String(describing: m))")
        hostRun { await w.sleep(5) }
        check("at once: the slow apps out on their own after", w.apps[started["com.apple.Notes"]!] == nil && w.apps[started["com.apple.calculator"]!] == nil)
    }

    // ---- the person's Phone given back at Margin's quit: each step condition-based and timed in the log ----
    for what in ["window mode, parked", "window mode, its frame refused", "full screen, parked", "full screen, its state unread", "full screen, refused"] {
        let (w, e, marker) = world()
        _ = wired(e)
        let full = what.hasPrefix("full screen")
        if full { w.notFullScreen.remove("com.apple.mobilephone") } // (a Dock app's window can go full screen)
        let p = w.start("com.apple.mobilephone", policy: .regular, windows: 1)
        let n = w.apps[p]!.windows[0]
        let original = w.wins[n]?.frame ?? FakeHostWorld.defaultFrame
        _ = open(e, textEdit)
        _ = open(e, phone)
        let parked = what.hasSuffix("parked") || what.hasSuffix("unread")
        if parked { _ = open(e, textEdit) } // (Phone parked behind it; else shown, its frame refused as it's given back)
        check("person's Phone at quit (\(what)): \(parked ? "parked" : "shown"), \(full ? "full screen" : "in window mode")", (parked ? w.wins[n]?.priv != nil : e.shown == phone.id) && e.mode(of: phone.id) == (full ? .fullScreen : .window), "\(String(describing: e.mode(of: phone.id)))")
        w.axCurrentOnly = true
        if what.hasSuffix("its frame refused") { w.fail = ["frame"] }
        if what.hasSuffix("its state unread") { w.fullScreenUnread = [n] }
        if what.hasSuffix("refused") && full { w.fail = ["ax"] }
        w.calls = []
        let t0 = w.clock
        let lines = said { hostRun { await e.quitAll() } }
        let took = w.clock - t0
        let line = lines.first { $0.contains("app:com.apple.mobilephone closed (Margin quits)") } ?? ""
        let refused = what.hasSuffix("refused")
        check("person's Phone at quit (\(what)): given back in \(Int(took * 1000)) ms, never quit, on its Desktop\(refused ? "" : " at its frame, out of full screen")",
              took < (refused ? 0.7 : 0.3) && w.apps[p] != nil && !w.calls.contains("terminate \(p)") && w.spaces(window: n) == [FakeHostWorld.desktop] && w.privates.isEmpty
              && (refused || (w.bounds(window: n) == original && w.wins[n]?.fullScreen == false)), "\(took) \(w.calls) \(lines.filter { $0.contains("mobilephone") })")
        print("  (person's Phone at quit, \(what): given back in \(Int(took * 1000)) ms: \(line.components(separatedBy: " ms (").last.map { "(" + $0 } ?? line))")
        check("person's Phone at quit (\(what)): its steps timed in the log", line.contains(full ? "out of full screen " : "frame ") && line.contains("home "), line)
        let m = HostMarker.read(marker)
        let left = m?.windows.first { $0.number == n }
        let kept = what.hasSuffix("refused")
        check("person's Phone at quit (\(what)): \(kept ? "what isn't done (\(full ? "its exit from full screen" : "its frame")) in the marker for the next launch (the person's, its frame)" : "nothing of it in the marker")",
              kept ? left?.personApp == true && left?.frame == original && (full ? left?.member == true : left?.frameChanged == true) : left == nil, "\(String(describing: m))")
        if kept {
            // The next launch, Accessibility answering again: finished, the marker gone.
            w.fail = []
            w.current = FakeHostWorld.desktop // (Margin's window and Space went with it)
            let next = HostEngine(system: w, marker: marker, pid: 2)
            hostRun { await next.recover() }
            check("person's Phone at quit (\(what)): the next launch finishes it: out of full screen, at its frame, on its Desktop, still running, the marker gone",
                  w.wins[n]?.fullScreen == false && w.bounds(window: n) == original && w.spaces(window: n) == [FakeHostWorld.desktop] && w.apps[p] != nil && !FileManager.default.fileExists(atPath: marker.path), "\(w.calls.suffix(8))")
        }
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
        check("person's app parked: in a private Space as it is, at the page area's frame (given back only with it)", w.wins[n]?.priv != nil && w.wins[n]?.frame == page)
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
        check("window mode: Margin's window leaving full screen: parked as it is (at the page area's frame), nothing shown", w.wins[n]?.priv != nil && w.wins[n]?.frame == page && e.shown == nil && h.above.last == .some(nil))
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
        check("crash: (Phone shown at the page area, FaceTime parked at the page area's frame, its own in the marker)", w.bounds(window: n) == page && w.wins[f]?.priv != nil && w.wins[f]?.frame == page)
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
    check("host calls: the launch line", all.line(build: "26B131") == "private calls (host) on 26B131: host ok (12/12 functions and keys, 2/2 selectors, encodings ok); outside opens ok; tiles ok", all.line(build: "26B131"))
    check("host calls: the tiles on (live resize)", all.tiles && all.reasons["tiles"] == nil, "\(all)")
    // The tiles are a part of their own: anything of theirs missing or changed turns them off, never the host.
    for name in HostCalls.tileFunctions {
        let r = HostFakeResolver()
        r.functions.remove(name)
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: no \(name): the host on, the tiles off", a.host && !a.tiles && a.reasons["tiles"] == "\(name) missing", "\(a)")
    }
    for cls in HostCalls.tileClasses {
        let r = HostFakeResolver()
        r.tileClasses.remove(cls)
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: no \(cls): the host on, the tiles off", a.host && !a.tiles && (a.reasons["tiles"] ?? "").contains("\(cls) missing"), "\(a)")
    }
    for sel in HostCalls.tileSelectors {
        let r = HostFakeResolver()
        r.encodings[sel.label] = "@24@0:8Q16"
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: \(sel.label)'s encoding changed: the host on, the tiles off", a.host && !a.tiles && (a.reasons["tiles"] ?? "").contains("encoding changed"), "\(a)")
    }
    do {
        let r = HostFakeResolver()
        r.functions.remove(HostCalls.skyFunctions[1])
        check("host calls: the host off: the tiles off with it", !HostCalls.evaluate(r, base: base).tiles && HostCalls.evaluate(r, base: base).reasons["tiles"] == "the host is off")
    }
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
          && !wrappers.launchDockless(URL(fileURLWithPath: "/Applications/TextEdit.app"), arguments: [], done: { _ in }) && wrappers.listen(pid: 1, heard: { _ in }) == nil
          && wrappers.tiles(of: 5) == nil && wrappers.values(of: 5) == nil && !wrappers.setValues(5, ["TileRect": [:]]) && !wrappers.moveTile(6, to: 5, index: 1))
    check("host calls: the real resolver finds nothing in a test", HostCalls.evaluate(RealPrivateResolver(), base: base).host == false)
}

// A full-screen ask that can't work where the window is (2026-11-17, Maps on the real Mac: its window restored in full
// screen in a Space of its own, brought into Margin's Space to be read, read full screen with no Space of its own:
// nothing asked, 6 s, then window mode for the session), a refusal seen at once and asked again the proper way, a
// fallback tried again at the next show, and a window-mode window's Accessibility element gone stale.
func refusedFullScreenTests(world: () -> (FakeHostWorld, HostEngine, URL)) {
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let maps = HostTarget.app("com.apple.Maps"), textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    let faceTime = HostTarget.app("com.apple.FaceTime"), calculator = HostTarget.app("com.apple.calculator")
    func placed() -> HostPlacement { HostPlacement(page: page, area: FakeHostWorld.display) }
    func open(_ e: HostEngine, _ t: HostTarget) -> HostResult? {
        hostRun { await e.open(app: t, in: placed(), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func clean(_ w: FakeHostWorld) -> Bool { w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && w.destroyedWithWindows == 0 && !w.frozen }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func at(_ w: FakeHostWorld, _ call: String) -> Int { w.calls.firstIndex(of: call) ?? -1 }
    final class Lines { var all: [String] = [] }
    func listen() -> (Lines, () -> Void) {
        let l = Lines(), echo = Diagnostics.echo
        Diagnostics.echo = { l.all.append($0) }
        return (l, { Diagnostics.echo = echo })
    }
    func said(_ l: Lines, _ what: String) -> Int { l.all.filter { $0.contains(what) }.count }
    func member(_ w: FakeHostWorld, _ n: Int) -> Bool {
        w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.wins[n]?.member == true && w.wins[n]?.fullScreen == true && w.bounds(window: n) == page
    }

    // ---- its window restored in full screen in a Space of its own (its app hidden): placed from there ----
    do {
        let (w, e, _) = world()
        w.installed.insert("com.apple.Maps")
        w.restoredFullScreen = ["com.apple.Maps"]
        w.axCurrentOnly = true // (its Space isn't current: Accessibility lists nothing of it, as on the real Mac)
        w.staged = true
        var loading: [HostID?] = []
        e.loading = { loading.append($0) }
        let (lines, done) = listen()
        let t0 = w.clock
        let r = open(e, maps)
        let took = w.clock - t0
        done()
        let n = window(w, "com.apple.Maps"), own = w.restoredSpaces.first ?? 0
        check("restored full screen: Maps' window, restored by its app in full screen in a Space of its own, ends full screen at the page area, a member of Margin's Space (not window mode)",
              r == .shown(maps.id, placed: true) && e.mode(of: maps.id) == .fullScreen && member(w, n), "\(String(describing: r)) \(String(describing: e.mode(of: maps.id))) \(String(describing: w.wins[n]))")
        check("restored full screen: shown in \(Int(took * 1000)) ms on the stand-in's clock (it was 6 s of waiting, then window mode)", took < 2, "\(took)")
        check("restored full screen: its own Space reserved before the window was moved into Margin's Space; never moved in to be read first; that Space destroyed",
              at(w, "reserve 276/8/8/8") >= 0 && at(w, "reserve 276/8/8/8") < at(w, "move \(n) \(FakeHostWorld.marginSpace)")
              && w.calls.filter { $0 == "move \(n) \(FakeHostWorld.marginSpace)" }.count == 1 && w.reserves.first?.space == own && w.tiles[own] == nil && clean(w), "\(w.calls)")
        check("restored full screen: nothing asked of it (it was in full screen already), never a frame set by Accessibility",
              !w.calls.contains { $0.hasPrefix("fullScreen true \(n)") || $0.hasPrefix("frame \(n)") }, "\(w.calls)")
        check("restored full screen: the loading card for it from the start to the end", loading == [maps.id, nil], "\(loading)")
        check("restored full screen: the log says once that it came up so and was placed from there; no window mode",
              said(lines, "came up in full screen in a Space of its own") == 1 && said(lines, "shown in window mode") == 0 && said(lines, "backed out") == 0, "\(lines.all.filter { $0.contains("Maps") })")
        hostRun { await e.quitAll() }
        check("restored full screen: quit: out of full screen first, nothing left", w.fullScreenAtQuit["com.apple.Maps"] == false && clean(w))
    }

    // ---- ...whose Space doesn't lay it out: window mode, its frame the window's own (not its full-screen bounds) ----
    do {
        let (w, e, _) = world()
        w.installed.insert("com.apple.Maps")
        w.restoredFullScreen = ["com.apple.Maps"]
        w.noLayout = ["com.apple.Maps"]
        w.axCurrentOnly = true
        let (lines, done) = listen()
        let r = open(e, maps)
        let n = window(w, "com.apple.Maps")
        check("restored full screen, not laid out by its Space: backed out (out of full screen on the current Space) and shown in window mode, its Space gone",
              r == .shown(maps.id, placed: true) && e.mode(of: maps.id) == .window && w.wins[n]?.fullScreen == false && w.bounds(window: n) == page && w.restoredSpaces.allSatisfy { w.tiles[$0] == nil } && clean(w),
              "\(String(describing: r)) \(String(describing: w.wins[n])) \(w.tiles)")
        _ = open(e, notes)
        hostRun { await e.quitAll() }
        done()
        check("restored full screen, then window mode: parked, then given back at Margin's quit: its frame given back is the window's own (\(w.frameAtQuit["com.apple.Maps"].map { "\($0)" } ?? "none")), never its full-screen bounds; no \"wasn't given back\"",
              w.frameAtQuit["com.apple.Maps"] == FakeHostWorld.defaultFrame && said(lines, "wasn't given back") == 0 && !w.calls.contains("frame \(n) 0,33 1512×949"), "\(w.calls.filter { $0.hasPrefix("frame \(n)") })")
    }

    // ---- full screen by Accessibility with no Space of its own (in Margin's Space): out of it first, then asked ----
    do {
        let (w, e, _) = world()
        w.installed.insert("com.apple.Maps")
        w.restoredAsMember = ["com.apple.Maps"]
        w.staged = true
        let (lines, done) = listen()
        let t0 = w.clock
        let r = open(e, maps)
        let took = w.clock - t0
        done()
        let n = window(w, "com.apple.Maps")
        let out = at(w, "fullScreen false \(n)"), ask = at(w, "fullScreen true \(n)")
        check("full screen with no Space of its own: taken out of full screen where it is, then asked: full screen at the page area by the early path in \(Int(took * 1000)) ms (it was 6 s, then window mode)",
              r == .shown(maps.id, placed: true) && e.mode(of: maps.id) == .fullScreen && member(w, n) && out >= 0 && out < ask && took < 2
              && said(lines, "reads full screen with no full-screen Space of its own") == 1 && said(lines, "full screen by the early path") == 1 && said(lines, "window mode") == 0 && clean(w),
              "\(String(describing: r)) \(took) \(w.calls)")
        hostRun { await e.quitAll() }
    }

    // ---- refused in Margin's Space, taken on the Desktop: asked again the proper way at 1.5 s, full screen ----
    do {
        let (w, e, _) = world()
        w.launchInCurrent = true // (its window opens in Margin's Space, the current one)
        w.desktopOnlyFullScreen = ["com.apple.TextEdit"]
        w.staged = true
        var loading: [HostID?] = []
        e.loading = { loading.append($0) }
        let (lines, done) = listen()
        let t0 = w.clock
        let r = open(e, textEdit)
        let took = w.clock - t0
        done()
        let n = window(w, "com.apple.TextEdit"), p = w.running(bundleId: "com.apple.TextEdit").first?.pid ?? 0
        check("refused: an app whose full screen macOS refuses in Margin's Space ends full screen at the page area all the same (not window mode)",
              r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .fullScreen && member(w, n) && w.refusedAsks == 1, "\(String(describing: r)) \(w.refusedAsks) \(String(describing: w.wins[n]))")
        let again = w.calls.firstIndex(of: "move \(n) \(FakeHostWorld.desktop)") ?? -1, asks = w.calls.indices.filter { w.calls[$0] == "fullScreen true \(n)" }
        check("refused: asked again once, the proper way: moved onto its Desktop, its app in front, then asked",
              asks.count == 2 && again >= 0 && again < asks[1] && (w.calls[again..<asks[1]].contains("activate \(p) \(n)")), "\(w.calls)")
        check("refused: shown in \(Int(took * 1000)) ms on the stand-in's clock (the refusal seen at 1.5 s; it was 6 s, then window mode)", took < 3.5, "\(took)")
        check("refused: the loading card for it from start to end, a freeze taken anew for the ask again, Margin's Space current at the end, nothing left",
              loading == [textEdit.id, nil] && w.freezes == 2 && w.reveals == 2 && w.current == FakeHostWorld.marginSpace && clean(w), "\(loading) \(w.freezes) \(w.reveals) \(w.current)")
        check("refused: the log says it was moved out of Margin's Space first, once; no window mode",
              said(lines, "its full screen refused") == 1 && said(lines, "moved out of Margin's Space onto its Desktop first") == 1 && said(lines, "window mode") == 0, "\(lines.all.filter { $0.contains("refused") })")
        hostRun { await e.quitAll() }
    }

    // ---- its window opened in another app's full-screen Space (the current one then): onto its Desktop before the ask ----
    do {
        let (w, e, _) = world()
        let theirs: UInt64 = 900
        w.tiles[theirs] = [901]
        w.owner[theirs] = 77 // (the person's own full-screen app)
        w.theirSpaces = [theirs]
        w.current = theirs
        w.launchInCurrent = true
        w.desktopOnlyFullScreen = ["com.apple.TextEdit"] // (refused while it's in any full-screen Space)
        w.staged = true
        let (lines, done) = listen()
        let t0 = w.clock
        let r = open(e, textEdit)
        let took = w.clock - t0
        done()
        let n = window(w, "com.apple.TextEdit")
        check("another app's Space: its window, opened in the person's full-screen Space, moved onto its Desktop before the ask: full screen at the page area at the first ask, in \(Int(took * 1000)) ms",
              r == .shown(textEdit.id, placed: true) && member(w, n) && w.refusedAsks == 0 && w.calls.filter { $0 == "fullScreen true \(n)" }.count == 1 && took < 2
              && at(w, "move \(n) \(FakeHostWorld.desktop)") < at(w, "fullScreen true \(n)") && said(lines, "of another app's (900): moved onto its Desktop first") == 1
              && w.tiles[theirs] != nil, "\(String(describing: r)) \(took) \(w.calls)")
        hostRun { await e.quitAll() }
    }

    // ---- refused everywhere: window mode after 3 s, not 6; tried again at the next show, once ----
    do {
        let (w, e, _) = world()
        w.fail = ["fullScreen"] // (its AXFullScreen is settable, but no full-screen Space ever comes)
        let (lines, done) = listen()
        let t0 = w.clock
        let r = open(e, textEdit)
        let took = w.clock - t0
        let n = window(w, "com.apple.TextEdit")
        check("refused everywhere: window mode after \(Int(took * 1000)) ms on the stand-in's clock (each ask refused within 1.5 s; it was 6 s)",
              r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .window && took < 3.6 && w.calls.filter { $0 == "fullScreen true \(n)" }.count == 2, "\(took) \(w.calls)")
        check("refused everywhere: the fallback said as one of an app that can go full screen, to be tried again",
              said(lines, "backed out, shown in window mode (it can go full screen: tried again the next time it's shown)") == 1 && said(lines, "nor of the ask again from its Desktop") == 1, "\(lines.all.filter { $0.contains("window mode") })")
        w.fail = []
        _ = open(e, notes)
        var loading: [HostID?] = []
        e.loading = { loading.append($0) }
        let back = hostRun { await e.show(textEdit.id) }
        check("refused everywhere: shown again, full screen tried again behind the loader, and taken: a member at the page area",
              back == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .fullScreen && member(w, n) && loading == [textEdit.id, nil]
              && said(lines, "full screen tried again as it's shown") == 1 && clean(w), "\(String(describing: back)) \(loading) \(String(describing: w.wins[n]))")
        hostRun { await e.quitAll() }
        done()
    }
    do {
        let (w, e, _) = world()
        w.fail = ["fullScreen"]
        let (lines, done) = listen()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let back = hostRun { await e.show(textEdit.id) }
        _ = open(e, notes)
        let calls = w.calls.count
        let third = hostRun { await e.show(textEdit.id) }
        done()
        check("refused again at its next show: window mode, said so; not tried a third time",
              back == .shown(textEdit.id, placed: true) && third == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .window
              && lines.all.filter({ $0.contains("TextEdit") && $0.contains("failed again, window mode from now on") }).count == 1 && !w.calls[calls...].contains { $0.hasPrefix("fullScreen true") }, "\(lines.all.filter { $0.contains("window mode") })")
        hostRun { await e.quitAll() }
    }

    // ---- tried again at its next show: unparked onto its Desktop, refused there (not the current Space), its app in front
    // (macOS shows that Desktop): taken; Margin's Space current again ----
    do {
        let (w, e, _) = world()
        w.fail = ["fullScreen"]
        _ = open(e, textEdit)
        _ = open(e, notes)
        w.fail = []
        w.currentOnlyFullScreen = true
        w.activateShowsDesktop = true
        w.staged = true
        let refusedBefore = w.refusedAsks
        let (lines, done) = listen()
        let t0 = w.clock
        let back = hostRun { await e.show(textEdit.id) }
        let took = w.clock - t0
        done()
        let n = window(w, "com.apple.TextEdit")
        check("tried again from its Desktop: refused there at first, asked again with its app in front (its Desktop made current), taken: full screen at the page area in \(Int(took * 1000)) ms, Margin's Space current at the end",
              back == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .fullScreen && member(w, n) && w.refusedAsks == refusedBefore + 1
              && w.current == FakeHostWorld.marginSpace && took < 3.5 && said(lines, "its app in front, asked again") == 1 && clean(w),
              "\(String(describing: back)) \(took) \(w.current) \(w.refusedAsks) \(lines.all.filter { $0.contains("TextEdit") })")
        hostRun { await e.quitAll() }
    }
    // ---- ...refused there again: window mode, and Margin's Space current again (never left on its Desktop) ----
    do {
        let (w, e, _) = world()
        w.fail = ["fullScreen"]
        _ = open(e, textEdit)
        _ = open(e, notes)
        w.activateShowsDesktop = true
        let back = hostRun { await e.show(textEdit.id) }
        check("tried again from its Desktop, refused again: window mode in the page area, Margin's Space current (its app's activation had made its Desktop current)",
              back == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .window && w.current == FakeHostWorld.marginSpace
              && w.spaces(window: window(w, "com.apple.TextEdit")) == [FakeHostWorld.marginSpace], "\(String(describing: back)) \(w.current)")
        hostRun { await e.quitAll() }
    }

    // ---- a true window-mode app: unchanged (never asked into full screen, nothing tried again) ----
    do {
        let (w, e, _) = world()
        let (lines, done) = listen()
        let r = open(e, calculator)
        _ = open(e, notes)
        let back = hostRun { await e.show(calculator.id) }
        done()
        let n = window(w, "com.apple.calculator")
        check("window mode app (Calculator): window mode, never asked into full screen, nothing tried again at its next show",
              r == .shown(calculator.id, placed: true) && back == .shown(calculator.id, placed: true) && e.mode(of: calculator.id) == .window
              && !w.calls.contains { $0.hasPrefix("fullScreen true \(n)") } && said(lines, "tried again") == 0 && said(lines, "refused") == 0, "\(w.calls)")
        hostRun { await e.quitAll() }
    }

    // ---- a window-mode window's Accessibility element gone stale after a park: found again, placed ----
    do {
        let (w, e, _) = world()
        w.staleOnLeave = ["com.apple.FaceTime"]
        let (lines, done) = listen()
        _ = open(e, faceTime)
        _ = open(e, notes)
        let n = window(w, "com.apple.FaceTime")
        check("stale element: FaceTime's element gone stale once its window left for a private Space", w.axStale.contains(n))
        let mark = w.calls.count
        let back = hostRun { await e.show(faceTime.id) }
        check("stale element: shown again (a switch): at the page area's frame already, no frame set", back == .shown(faceTime.id, placed: true) && w.bounds(window: n) == page
              && !w.calls[mark...].contains { $0.hasPrefix("frame \(n) ") }, "\(w.calls[mark...])")
        // (The next frame it's given: the page area moved.)
        let page2 = CGRect(x: 320, y: 41, width: 1184, height: 933)
        let moved = hostRun { await e.pageRectChanged(HostPlacement(page: page2, area: FakeHostWorld.display)) }
        done()
        check("stale element: placed at a new page area: its element found again by its number after the refused set, the error code said",
              moved == true && w.bounds(window: n) == page2 && w.calls.contains("refresh \(n)")
              && said(lines, "Accessibility refused its frame (error -25202): its element found again by its number, the frame taken") == 1, "\(String(describing: back)) \(w.calls.suffix(8))")
        hostRun { await e.quitAll() }
        check("stale element: quit: its frame given back as it was", w.frameAtQuit["com.apple.FaceTime"] == FakeHostWorld.defaultFrame)
    }
}

// His session of 2026-11-17 14:04-14:08 (session-2026-11-17-1405.log), each case as the stand-in plays it: an app that
// attempts termination and goes on running (Maps), a window-mode window the on-screen list misses or its app has ordered
// out (Phone), an app refusing Accessibility while it launches and taking its full-screen ask late with a toolbar strip
// of its own (Mail), a window that couldn't be fitted over the sidebar, a window opened only to wake a profile (Safari).
func session1405Tests(world: () -> (FakeHostWorld, HostEngine, URL)) {
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    let calculator = HostTarget.app("com.apple.calculator"), faceTime = HostTarget.app("com.apple.FaceTime")
    func placed() -> HostPlacement { HostPlacement(page: page, area: FakeHostWorld.display) }
    func open(_ e: HostEngine, _ t: HostTarget) -> HostResult? {
        hostRun { await e.open(app: t, in: placed(), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func clean(_ w: FakeHostWorld) -> Bool { w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && w.destroyedWithWindows == 0 && !w.frozen }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func pid(_ w: FakeHostWorld, _ bundle: String) -> pid_t { w.running(bundleId: bundle).first?.pid ?? 0 }
    final class Lines { var all: [String] = [] }
    func listen() -> (Lines, () -> Void) {
        let l = Lines(), echo = Diagnostics.echo
        Diagnostics.echo = { l.all.append($0) }
        return (l, { Diagnostics.echo = echo })
    }
    func said(_ l: Lines, _ what: String) -> Int { l.all.filter { $0.contains(what) }.count }
    func member(_ w: FakeHostWorld, _ n: Int) -> Bool {
        w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.wins[n]?.member == true && w.wins[n]?.fullScreen == true && w.bounds(window: n) == page
    }
    func barrier(_ e: HostEngine) { _ = hostRun { await e.pageRectChanged(placed()) } } // (the page area as it is: the poll's work waited for)

    // ---- B: an app that attempts termination while parked and goes on running: never quit, still Margin's ----
    do {
        let (w, e, _) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let (lines, done) = listen()
        _ = open(e, textEdit)
        let p = pid(w, "com.apple.TextEdit")
        _ = open(e, notes) // (TextEdit parked: no window of its in any user Space)
        w.attemptTermination(p)
        e.poll(); e.poll()
        check("terminating: an app Margin started, parked, said to have quit while its process runs: not quit, still hosted and parked, still Margin's, said once",
              !events.contains(.quitByUser(textEdit.id)) && e.hosts[textEdit.id]?.phase == .parked && e.launchedPid(bundleId: "com.apple.TextEdit") == p && e.hosts[textEdit.id]?.launchedByMargin == true
              && said(lines, "its app was said to have quit, its process \(p) still runs: kept, still Margin's") == 1, "\(events) \(lines.all.filter { $0.contains("quit") })")
        w.lsGone = []
        let back = hostRun { await e.show(textEdit.id) }
        check("terminating: shown again: a switch to Margin's own app, never \"an app the person opened\"",
              back == .shown(textEdit.id, placed: true) && e.launchedPid(bundleId: "com.apple.TextEdit") == p && said(lines, "an app the person opened") == 0 && w.calls.filter { $0 == "launch com.apple.TextEdit" }.count == 1,
              "\(String(describing: back)) \(lines.all.suffix(3))")
        hostRun { await e.quitAll() }
        done()
        check("terminating: Margin's quit asks it to quit, as Margin's", w.running(bundleId: "com.apple.TextEdit").isEmpty && clean(w))
    }
    do {
        // Really quit (its process gone): forgotten, and its next open starts it again as Margin's.
        let (w, e, _) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let (lines, done) = listen()
        _ = open(e, textEdit)
        _ = open(e, notes)
        w.quitNow(pid(w, "com.apple.TextEdit"))
        let r = open(e, textEdit)
        done()
        check("terminating: really quit: forgotten at once, its next open starts it again with no Dock icon, as Margin's",
              events.contains(.quitByUser(textEdit.id)) && r == .shown(textEdit.id, placed: true) && w.calls.filter { $0 == "launch com.apple.TextEdit" }.count == 2
              && e.launchedPid(bundleId: "com.apple.TextEdit") != nil && said(lines, "an app the person opened") == 0, "\(String(describing: r))")
        hostRun { await e.quitAll() }
    }

    // ---- C: a window-mode window the on-screen list leaves out (its own read: on screen): nothing done ----
    do {
        let (w, e, _) = world()
        w.autoOnScreen = true
        let (lines, done) = listen()
        _ = open(e, calculator)
        let n = window(w, "com.apple.calculator")
        let mark = w.calls.count
        w.listDrops[n] = 3 // (the poll's read, the read again, and once more)
        for _ in 0..<5 { e.poll(); barrier(e) }
        done()
        check("window off the list: a window-mode window the on-screen list leaves out though it's on screen by its own read: no Space made current, nothing moved, nothing said",
              !w.calls[mark...].contains { $0.hasPrefix("current") || $0.hasPrefix("move") } && said(lines, "not on screen") == 0 && w.ownReads > 0, "\(w.calls[mark...]) \(lines.all.filter { $0.contains("screen") })")
        hostRun { await e.quitAll() }
    }
    // ---- C: a window-mode window really off screen in Margin's Space, the current one (its app ordered it out) ----
    do {
        let (w, e, _) = world()
        w.autoOnScreen = true
        let (lines, done) = listen()
        _ = open(e, faceTime)
        let n = window(w, "com.apple.FaceTime"), p = pid(w, "com.apple.FaceTime")
        w.minimized = [n] // (ordered out by its app: in Margin's Space, on no screen)
        let mark = w.calls.count
        e.poll(); barrier(e)
        let first = w.calls[mark...].filter { $0.hasPrefix("activate") || $0.hasPrefix("current") || $0.hasPrefix("move") }.isEmpty
        for _ in 0..<8 { e.poll(); barrier(e) }
        // (The reconciler's bringForward, a rung at a time: activated once, a Dock-icon click once, then the fallback: parked
        // with nothing shown, its item kept. Never a Space made current, never moved but into its private Space.)
        let moves = w.calls[mark...].filter { $0.hasPrefix("move") }
        check("window ordered out: a window-mode window off screen in Margin's Space (the current one), Margin's window on screen: not at the first read; no Space made current ever; brought forward once a rung (activated, a reopen), then parked with nothing shown; said once each",
              first && !w.calls[mark...].contains { $0.hasPrefix("current") } && w.calls[mark...].filter { $0 == "activate \(p) \(n)" }.count == 1 && w.calls[mark...].filter { $0 == "reopen \(p)" }.count == 1
              && moves.count == 1 && w.wins[n]?.priv != nil && e.shown == nil && e.isHosted(faceTime.id)
              && said(lines, "→ bring forward (activate)") == 1 && said(lines, "→ bring forward (reopen)") == 1 && said(lines, "→ fallback (its window stays off screen in Margin's Space)") == 1
              && said(lines, "Margin's Space made current again") == 0,
              "\(first) \(w.calls[mark...]) \(lines.all.filter { $0.contains("screen") || $0.contains("→") })")
        // Shown again (away and back), still ordered out: the same rungs again for that show, its budget anew.
        w.minimized = []
        _ = open(e, notes)
        _ = hostRun { await e.show(faceTime.id) }
        w.minimized = [n]
        let again = w.calls.count
        for _ in 0..<8 { e.poll(); barrier(e) }
        done()
        check("window ordered out: shown again, still ordered out: activated once more for that show, never a Space made current",
              w.calls[again...].filter { $0 == "activate \(p) \(n)" }.count == 1 && !w.calls[again...].contains { $0.hasPrefix("current") }, "\(w.calls[again...])")
        w.minimized = []
        hostRun { await e.quitAll() }
    }

    // ---- D: an app refusing Accessibility while it launches (kAXErrorCannotComplete for its first second) ----
    do {
        let (w, e, _) = world()
        w.staged = true
        w.launchInCurrent = true
        w.axBusyFor = ["com.apple.TextEdit": 1.0]
        let (lines, done) = listen()
        let r = open(e, textEdit)
        done()
        let n = window(w, "com.apple.TextEdit")
        check("launching: an app refusing Accessibility for its first second: its full screen asked again until it's taken, full screen at the page area, not window mode, said once",
              r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .fullScreen && member(w, n) && said(lines, "Accessibility didn't take its full screen at first") == 1
              && said(lines, "taken at try") == 1 && said(lines, "window mode") == 0 && clean(w), "\(String(describing: r)) \(lines.all.filter { $0.contains("TextEdit") && ($0.contains("full screen") || $0.contains("window mode")) })")
        hostRun { await e.quitAll() }
    }
    do {
        // ...and taking its first, refused ask late, with a toolbar strip of its own (Mail, 14:06:04): seen, followed.
        let (w, e, _) = world()
        w.staged = true
        w.launchInCurrent = true
        w.axBusyFor = ["com.apple.TextEdit": 1.0]
        w.takesLate = ["com.apple.TextEdit"]
        w.stripOnFullScreen = ["com.apple.TextEdit"]
        let (lines, done) = listen()
        let r = open(e, textEdit)
        done()
        let n = window(w, "com.apple.TextEdit")
        check("launching: its first ask refused and taken late: seen (its new Space listed), followed: full screen at the page area, never backed out to window mode",
              r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .fullScreen && member(w, n) && w.tookLate == 1
              && said(lines, "it went into full screen all the same") == 1 && said(lines, "window mode") == 0 && said(lines, "backed out") == 0 && clean(w),
              "\(String(describing: r)) \(lines.all.filter { $0.contains("TextEdit") && ($0.contains("full screen") || $0.contains("window mode")) })")
        hostRun { await e.quitAll() }
    }
    do {
        // A window-mode window's frame refused while its app launches: asked again, placed.
        let (w, e, _) = world()
        w.axBusyFor = ["com.apple.FaceTime": 1.0]
        let (lines, done) = listen()
        let r = open(e, faceTime)
        done()
        let n = window(w, "com.apple.FaceTime")
        check("launching: a window-mode window's frame refused (error -25200) while its app launches: asked again until taken, placed at the page area",
              r == .shown(faceTime.id, placed: true) && w.bounds(window: n) == page && said(lines, "error -25200: its app busy): asked again") == 1, "\(String(describing: r)) \(lines.all.filter { $0.contains("frame") })")
        hostRun { await e.quitAll() }
    }

    // ---- D: a full-screen attempt backed out leaves its toolbar strip: asked out again, never left ----
    do {
        let (w, e, _) = world()
        w.noLayout = ["com.apple.TextEdit"] // (its Space doesn't lay it out: the placing fails, backed out to window mode)
        w.stripOnFullScreen = ["com.apple.TextEdit"]
        w.stripLingers = ["com.apple.TextEdit"]
        let (lines, done) = listen()
        let r = open(e, textEdit)
        done()
        let n = window(w, "com.apple.TextEdit")
        check("strip: a full-screen attempt backed out whose toolbar strip stayed: asked out of full screen once more, the strip gone, then window mode at the page area",
              r == .shown(textEdit.id, placed: true) && e.mode(of: textEdit.id) == .window && w.bounds(window: n) == page && w.strips[n] == nil && !w.wins.values.contains { $0.frame == FakeHostWorld.stripFrame }
              && said(lines, "toolbar strip") == 1 && said(lines, "asked out of full screen once more, gone") == 1 && clean(w), "\(String(describing: r)) \(w.strips) \(lines.all.filter { $0.contains("strip") })")
        hostRun { await e.quitAll() }
    }

    // ---- D: the yield never lets a toolbar strip, nor a window over Margin's sidebar, in front ----
    do {
        let (w, e, _) = world()
        var others: [Int?] = []
        e.others = { others.append($0) }
        w.onScreen = []
        _ = open(e, textEdit)
        let a = window(w, "com.apple.TextEdit"), editPid = pid(w, "com.apple.TextEdit")
        w.clock += e.options.lateWatch
        let margin = ServerWindow(number: FakeHostWorld.marginWindow, pid: 1, layer: 1, bounds: FakeHostWorld.display)
        let hostedNow = ServerWindow(number: a, pid: editPid, bounds: page)
        func polls(_ n: Int) { for _ in 0..<n { w.clock += 0.25; e.poll() } }
        func list(_ extra: [ServerWindow]) { w.onScreen = [margin] + extra + [hostedNow]; for x in extra { w.serverSpaces[x.number] = [FakeHostWorld.marginSpace] } }
        list([])
        polls(2) // (a look at rest first: what comes after is the person's doing)
        let strip = ServerWindow(number: 901, pid: editPid, bounds: FakeHostWorld.stripFrame)
        list([strip])
        polls(4)
        let stripLet = others.contains(901)
        let over = ServerWindow(number: 902, pid: editPid, bounds: CGRect(x: 0, y: 33, width: 1000, height: 900))
        list([over])
        polls(4)
        let overLet = others.contains(902)
        let little = ServerWindow(number: 903, pid: editPid, bounds: CGRect(x: 200, y: 200, width: 600, height: 400)) // (reaching a little over the sidebar)
        list([little])
        polls(4)
        let littleLet = others.contains(903)
        let settings = ServerWindow(number: 904, pid: editPid, bounds: CGRect(x: 300, y: 20, width: 600, height: 400)) // (above the page area, beside the sidebar)
        list([settings])
        polls(4)
        check("yield: never a full-screen window's toolbar strip, nor a window over Margin's sidebar, even a little (docs/HOSTING-CORE.md: an auxiliary window in front only if it doesn't cover it); a Settings window beside it still let in front",
              !stripLet && !overLet && !littleLet && others.contains(904), "\(others)")
        w.onScreen = nil
        hostRun { await e.quitAll() }
    }

    // ---- D: a window-mode window that can't be fitted, over Margin's sidebar: never shown so ----
    do {
        let (w, e, _) = world()
        let p = w.start("com.apple.FaceTime", policy: .regular, windows: 1) // (the person's, its window the display's whole size)
        let n = w.apps[p]?.windows.first ?? 0
        w.wins[n]?.frame = FakeHostWorld.display
        w.fail = ["frame"]
        let (lines, done) = listen()
        let r = open(e, faceTime)
        check("unfitted: a window-mode window whose frame can't be set, at the display's size over Margin's sidebar: not shown (kept out of sight, still hosted), said",
              { if case .failed(.place, _)? = r { return true }; return false }() && e.shown == nil && e.isHosted(faceTime.id) && w.wins[n]?.priv != nil && w.spaces(window: n) == []
              && said(lines, "over Margin's sidebar): kept out of sight, tried again at its next show") >= 1, "\(String(describing: r)) \(String(describing: w.wins[n]))")
        w.fail = []
        let back = hostRun { await e.show(faceTime.id) }
        done()
        check("unfitted: its next show tries again: placed at the page area", back == .shown(faceTime.id, placed: true) && w.bounds(window: n) == page && e.shown == faceTime.id, "\(String(describing: back))")
        hostRun { await e.quitAll() }
        check("unfitted: quit: the person's window given back at its own frame, on its Desktop", w.wins[n]?.frame == FakeHostWorld.display && w.spaces(window: n) == [FakeHostWorld.desktop], "\(String(describing: w.wins[n]))")
    }

    // ---- A: a window opened only to wake a profile, parked out of sight as it comes ----
    do {
        let (w, e, _) = world()
        let (lines, done) = listen()
        _ = open(e, calculator) // (something shown: the page area a hole over it)
        let sp = w.start("com.apple.Safari", policy: .accessory, windows: 1)
        let theirs = w.apps[sp]?.windows.first ?? 0
        e.hideWoken(bundleId: "com.apple.Safari")
        func newWindow() -> Int {
            let n = w.nextWindow
            w.nextWindow += 1
            w.wins[n] = FakeHostWorld.Win(pid: sp, spaces: [w.current])
            w.apps[sp]?.windows.append(n)
            return n
        }
        let woken = newWindow()
        e.poll()
        let parked = w.wins[woken]?.priv != nil
        let later = newWindow() // (one more after it: the person's, never touched)
        e.poll()
        check("woken: the window an app opens only to wake a profile, in Margin's Space: parked out of sight at the next look, said; nothing else of the app's touched (its window before, one after)",
              parked && w.wins[later]?.priv == nil && w.wins[theirs]?.priv == nil && said(lines, "it opened only to wake a profile parked out of sight") == 1, "\(parked) \(String(describing: w.wins[woken])) \(String(describing: w.wins[later])) \(String(describing: w.wins[theirs])) \(lines.all.filter { $0.contains("wake") })")
        w.closeWindow(woken)
        let spaces = w.privates.count
        e.releaseWoken(bundleId: "com.apple.Safari")
        done()
        check("woken: closed and released: its private Space destroyed", w.privates.count == spaces - 1, "\(w.privates)")
        hostRun { await e.quitAll() }
    }
    do {
        // Looked for by the session while it waits for the profile's link (an open under way holds the poll off: the woken
        // window sat in Margin's Space over the page area for the 15 s the link took, 2026-11-17 20:47): parked at that
        // look, and counted (the press's evidence that it took). Nothing counted before the window is there.
        let (w, e, _) = world()
        let sp = w.start("com.apple.Safari", policy: .accessory, windows: 1)
        e.hideWoken(bundleId: "com.apple.Safari")
        let none = e.wokenWindows(bundleId: "com.apple.Safari")
        let n = w.nextWindow
        w.nextWindow += 1
        w.wins[n] = FakeHostWorld.Win(pid: sp, spaces: [w.current])
        w.apps[sp]?.windows.append(n)
        let one = e.wokenWindows(bundleId: "com.apple.Safari") // (no poll: as during an open)
        check("woken: looked for between polls (an open under way): the window parked out of sight at once and counted; none before it came",
              none == 0 && one == 1 && w.wins[n]?.priv != nil && e.appRuns(bundleId: "com.apple.Safari") == true && e.appRuns(bundleId: "com.apple.Notes") == false,
              "\(none) \(one) \(String(describing: w.wins[n]))")
        w.closeWindow(n)
        e.releaseWoken(bundleId: "com.apple.Safari")
        hostRun { await e.quitAll() }
    }
}
