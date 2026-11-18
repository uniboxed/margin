// The behaviour classes of docs/HOSTING-CORE.md in the stand-in world: each of Chameleon's switches
// (tools/screen-tests/apps/Chameleon/Switches.swift, compiled in here by tools/app-tests/run.sh) played by an app of
// FakeHostWorld (host-tests.swift), so the host engine (and, from stage 3, its reconciler) is tested off screen against
// the same behaviours the real-screen suite (tools/screen-tests) hosts Chameleon with. Part of tests.swift's run
// (`behaviourWorldTests`): the switches' parsing, and that each stand-in behaviour does what its class says.
//
// `BehaviourWorld(world)` wraps a FakeHostWorld; `add(bundle, switches)` installs an app with those switches. What
// FakeHostWorld already plays is set through its own knobs (noFullScreen → notFullScreen, fixedSize, dialogMain →
// axRoles, axBusy → axBusyFor, strip fullscreen/linger → stripOnFullScreen/stripLingers); the rest is played here, at
// each launch (FakeHostWorld.onLaunch) and each step of its clock (onClock, from its sleeps; `tick()` by hand):
//   restore        n windows at launch; the full-screen ones each in a Space of its own (owned by the app, listed, as
//                  the Dock makes it while the app launches), the app not hidden;
//   windowless     off: the app quits once its last window is gone (a single-window app); YES: runs with none;
//                  close:<s>: closes its own window <s> after it's first on screen;
//   autoTerminate  attempt:<s>: <s> with no window in a user Space, it attempts termination (NSWorkspace says it quit,
//                  its process runs on: FakeHostWorld.attemptTermination); quit:<s>: really quits; system: quits 2 s
//                  after it has none, unless launched with `-NSDisableAutomaticTermination YES`;
//   ordersOut      untilActive: its window in no Space until the app is activated; after:<s>: out of every Space <s>
//                  after first on screen, back in the current Space at its next activation; every:<s>: out for 0.5 s
//                  every <s>;
//   replacesWindow every:<s>: a new window (a new number) at the old one's frame in the current Space, the old one
//                  closed, every <s> after first on screen (the new one is the app's main window); twin: a second
//                  window at the main one's frame;
//   strip          at:<s>,for:<s>: a full-width 88-tall window across the current Space's top for that long;
//   auxiliary      a small window (settings: 520×420; sidebar: 1000×800 at the display's top left) in the current
//                  Space at launch or <s> after, for <s> or for good;
//   extraWindow    another normal window in the current Space on `openExtra` (the menu item, the notification) or <s>
//                  after launch.
// `reopen(pid:)` plays a Dock-icon click (kAEReopenApplication): its main window ordered in, or a new one made.
import AppKit
import Foundation

final class BehaviourWorld {
    let world: FakeHostWorld
    private(set) var switches: [String: ChameleonSwitches] = [:]
    private(set) var said: [String] = [] // what the stand-in apps did, as Chameleon's own log would say it
    private var launchedAt: [pid_t: Double] = [:]
    private var arguments: [pid_t: [String]] = [:]
    private var firstShown: [pid_t: Double] = [:]
    private var hadWindows: Set<pid_t> = []
    private var orderedOut: [pid_t: (window: Int, activations: Int)] = [:]
    private var orderedOutOnce: Set<pid_t> = []
    private var hopBack: [pid_t: (window: Int, spaces: [UInt64], at: Double)] = [:]
    private var lastHop: [pid_t: Double] = [:]
    private var lastReplace: [pid_t: Double] = [:]
    private var closedOwn: Set<pid_t> = []
    private var noWindowSince: [pid_t: Double] = [:]
    private var attempted: Set<pid_t> = []
    private var auxiliary: [pid_t: (window: Int?, closeAt: Double?)] = [:]
    private var strip: [pid_t: (window: Int?, closeAt: Double?)] = [:]
    private var extraDone: Set<pid_t> = []
    // The windows the switches made beside the main one that the person may keep (an auxiliary, an extra window), and when
    // each app last replaced its main window (the suite's tolerance for the moment between a replacement and its adoption).
    private(set) var kept: Set<Int> = []
    private(set) var replacedAt: [pid_t: Double] = [:]

    init(_ world: FakeHostWorld) {
        self.world = world
        world.onLaunch = { [weak self] pid in self?.launched(pid) }
        world.onClock = { [weak self] in self?.tick() }
        world.onReopen = { [weak self] pid in self?.reopen(pid: pid) }
    }

    func add(_ bundle: String, _ s: ChameleonSwitches) {
        switches[bundle] = s
        world.installed.insert(bundle)
        world.keepsClosed.insert(bundle) // (its windows aren't released when closed: listed a while after, as on the real Mac)
        if s.noFullScreen { world.notFullScreen.insert(bundle) }
        if let size = s.fixedSize { world.fixedSize[bundle] = size }
        if s.dialogMain { world.axRoles[bundle] = "AXWindow/AXDialog" }
        if let busy = s.axBusy { world.axBusyFor[bundle] = busy }
        if case .onFullScreen(let linger)? = s.strip { world.stripOnFullScreen.insert(bundle); if linger { world.stripLingers.insert(bundle) } }
    }
    func add(_ bundle: String, _ raw: [String: String]) { add(bundle, ChameleonSwitches.parse(raw)) }

    private func switchesOf(_ pid: pid_t) -> ChameleonSwitches? { world.apps[pid].flatMap { switches[$0.bundle] } }
    private func note(_ pid: pid_t, _ what: String) { said.append("\(world.apps[pid]?.bundle ?? "?") \(String(format: "%.2f", world.clock)): \(what)") }
    func mainWindow(_ pid: pid_t) -> Int? { world.main[pid] ?? world.apps[pid]?.windows.first }
    private func activations(_ pid: pid_t) -> Int { world.calls.filter { $0.hasPrefix("activate \(pid) ") }.count }
    // The windows of an app in a user Space (not parked in a private one, not ordered out), its strips and spares left out.
    func inUserSpaces(_ pid: pid_t) -> [Int] { (world.apps[pid]?.windows ?? []).filter { n in world.wins[n].map { $0.priv == nil && !$0.spaces.isEmpty } ?? false } }

    @discardableResult private func addWindow(_ pid: pid_t, frame: CGRect?, spaces: [UInt64]) -> Int {
        let n = world.nextWindow
        world.nextWindow += 1
        var w = FakeHostWorld.Win(pid: pid, spaces: spaces, frame: frame)
        if let bundle = world.apps[pid]?.bundle {
            w.canFullScreen = !world.notFullScreen.contains(bundle)
            if let size = world.fixedSize[bundle] { w.resizable = false; w.frame = CGRect(origin: frame?.origin ?? CGPoint(x: 400, y: 300), size: size) }
            w.axRole = world.axRoles[bundle]
        }
        world.wins[n] = w
        world.apps[pid]?.windows.append(n)
        return n
    }
    // A window restored in full screen: a Space of its own made for it as the app launched (the Dock's).
    private func restoreInFullScreen(_ n: Int, pid: pid_t) {
        let space = world.nextId, tile = world.nextId + 1
        world.nextId += 2
        world.tiles[space] = [tile]
        world.owner[space] = pid
        world.tileWindow[tile] = n
        world.restoredSpaces.insert(space)
        world.wins[n]?.fullScreen = true
        world.wins[n]?.spaces = [space]
        world.noteListing()
    }

    func launched(_ pid: pid_t) {
        guard let a = world.apps[pid], let s = switches[a.bundle] else { return }
        launchedAt[pid] = world.clock
        arguments[pid] = world.lastArguments
        let spaces = a.windows.first.flatMap { world.wins[$0]?.spaces } ?? [FakeHostWorld.desktop]
        // (Its first window its main one, as Accessibility says it: what it makes beside it later isn't.)
        if world.main[pid] == nil, let first = a.windows.first { world.main[pid] = first }
        if let r = s.restore {
            // (Restored by AppKit: its windows kept at quit, NSQuitAlwaysKeepsWindows, as the suite's priming sets it.)
            if r.via == .system { world.keepsWindows.insert(a.bundle) }
            var list = a.windows
            while list.count < r.count { list.append(addWindow(pid, frame: FakeHostWorld.defaultFrame.offsetBy(dx: CGFloat(30 * list.count), dy: CGFloat(30 * list.count)), spaces: spaces)) }
            for (i, n) in list.prefix(r.count).enumerated() where r.fullScreen[i] { restoreInFullScreen(n, pid: pid) }
            note(pid, "restored \(r.count) window(s), \(r.fullScreen.filter { $0 }.count) in full screen")
        }
        if s.replacesWindow?.twin == true, let m = mainWindow(pid), let w = world.wins[m] {
            let t = addWindow(pid, frame: w.frame ?? FakeHostWorld.defaultFrame, spaces: w.spaces)
            note(pid, "twin \(t) of \(m)")
        }
        if s.ordersOut == .untilActive, let m = mainWindow(pid) {
            world.wins[m]?.spaces = []
            world.orderedOut.insert(m)
            orderedOut[pid] = (m, activations(pid))
            note(pid, "main window \(m) not ordered in until activated")
        }
        if !(world.apps[pid]?.windows.isEmpty ?? true) { hadWindows.insert(pid) }
        tick()
    }

    // A Dock-icon click: its main window ordered in (the current Space), or a new one made if it has none.
    @discardableResult func reopen(pid: pid_t) -> Int? {
        guard world.apps[pid] != nil else { return nil }
        if let m = mainWindow(pid), world.wins[m] != nil {
            if world.orderedOut.remove(m) != nil || world.wins[m]?.spaces.isEmpty == true, world.wins[m]?.priv == nil {
                if world.wins[m]?.spaces.isEmpty == true { world.wins[m]?.spaces = [world.current] }
                orderedOut[pid] = nil
            }
            note(pid, "reopen: \(m) ordered in")
            return m
        }
        let n = addWindow(pid, frame: nil, spaces: [world.current])
        world.main[pid] = n
        hadWindows.insert(pid)
        note(pid, "reopen: new window \(n)")
        return n
    }
    // Ordered in again (its app's activation): in the current Space if it's in none, where it is otherwise (a window the
    // bridge moved while it was ordered out keeps that Space).
    private func orderIn(_ n: Int) {
        world.orderedOut.remove(n)
        if world.wins[n]?.spaces.isEmpty == true, world.wins[n]?.priv == nil { world.wins[n]?.spaces = [world.current] }
    }
    // Another main-kind window (the menu item or the suite's notification).
    @discardableResult func openExtra(bundle: String) -> Int? {
        guard let pid = world.running(bundleId: bundle).first?.pid else { return nil }
        // (Where Chameleon's opened on the real Mac, 2026-11-17: 900×560, 60 pt over Margin's sidebar.)
        let n = addWindow(pid, frame: CGRect(x: 216, y: 250, width: 900, height: 560), spaces: [world.current])
        kept.insert(n)
        note(pid, "extra window \(n)")
        return n
    }

    // Each step of the clock: every behaviour that's due.
    func tick() {
        let now = world.clock
        for pid in world.apps.keys.sorted() {
            guard let s = switchesOf(pid), let start = launchedAt[pid] else { continue }
            let windows = world.apps[pid]?.windows ?? []
            if !windows.isEmpty { hadWindows.insert(pid) }
            if firstShown[pid] == nil, let m = mainWindow(pid), world.shows(m) { firstShown[pid] = now }
            let shownFor = firstShown[pid].map { now - $0 + 1e-9 }
            // windowless: off, the app quits with its last window; close:<s>: its own window closed.
            if windows.isEmpty, hadWindows.contains(pid), s.quitsAfterLastWindow {
                note(pid, "last window closed: quitting")
                world.quitNow(pid)
                continue
            }
            if case .closesAfter(let after)? = s.windowless, let t = shownFor, t >= after, !closedOwn.contains(pid), let m = mainWindow(pid) {
                closedOwn.insert(pid)
                world.closeWindow(m)
                world.main[pid] = nil
                note(pid, "closed its own window \(m): running with \(world.apps[pid]?.windows.count ?? 0)")
            }
            // ordersOut
            switch s.ordersOut {
            case .untilActive?:
                if let o = orderedOut[pid], activations(pid) > o.activations { orderIn(o.window); orderedOut[pid] = nil; note(pid, "activated: \(o.window) ordered in") }
            case .after(let after)?:
                if let t = shownFor, t >= after, !orderedOutOnce.contains(pid), let m = mainWindow(pid) {
                    orderedOutOnce.insert(pid)
                    world.wins[m]?.spaces = []
                    world.orderedOut.insert(m)
                    orderedOut[pid] = (m, activations(pid))
                    note(pid, "ordered out \(m)")
                } else if let o = orderedOut[pid], activations(pid) > o.activations {
                    orderIn(o.window); orderedOut[pid] = nil; note(pid, "activated: \(o.window) ordered in")
                }
            case .every(let every)?:
                if let back = hopBack[pid], now + 1e-9 >= back.at { world.wins[back.window]?.spaces = back.spaces; world.orderedOut.remove(back.window); hopBack[pid] = nil; note(pid, "ordered in \(back.window)") }
                if let first = firstShown[pid], hopBack[pid] == nil, now - (lastHop[pid] ?? first) + 1e-9 >= every, let m = mainWindow(pid), let w = world.wins[m], !w.spaces.isEmpty {
                    lastHop[pid] = now
                    hopBack[pid] = (m, w.spaces, now + 0.5)
                    world.wins[m]?.spaces = []
                    world.orderedOut.insert(m)
                    note(pid, "ordered out \(m) (every \(every) s)")
                }
            case nil: break
            }
            // replacesWindow every:<s>
            if let every = s.replacesWindow?.every, let first = firstShown[pid], now - (lastReplace[pid] ?? first) + 1e-9 >= every, let old = mainWindow(pid), let w = world.wins[old] {
                lastReplace[pid] = now
                let frame = w.fullScreen ? FakeHostWorld.defaultFrame : (world.bounds(window: old) ?? FakeHostWorld.defaultFrame)
                let new = addWindow(pid, frame: frame, spaces: [world.current])
                world.main[pid] = new
                world.closeWindow(old)
                replacedAt[pid] = now
                note(pid, "replaced \(old) by \(new)")
            }
            // strip at:<s>,for:<s>
            if case .timed(let at, let lasts)? = s.strip {
                if strip[pid] == nil, now - start + 1e-9 >= at {
                    var x = FakeHostWorld.Win(pid: pid, spaces: [world.current], frame: FakeHostWorld.stripFrame)
                    x.canFullScreen = false
                    x.axRole = "AXWindow/AXUnknown"
                    let n = world.nextWindow
                    world.nextWindow += 1
                    world.wins[n] = x
                    world.apps[pid]?.windows.append(n)
                    strip[pid] = (n, now + lasts)
                    note(pid, "strip \(n)")
                } else if let st = strip[pid], let n = st.window, let at = st.closeAt, now + 1e-9 >= at {
                    world.closeWindow(n)
                    strip[pid] = (nil, nil)
                    note(pid, "strip \(n) closed")
                }
            }
            // auxiliary
            if let a = s.auxiliary {
                if auxiliary[pid] == nil, now - start + 1e-9 >= (a.at ?? 0) {
                    let f = ChameleonSwitches.auxiliaryFrame(a.place, screen: CGRect(x: 0, y: 0, width: FakeHostWorld.display.width, height: FakeHostWorld.display.maxY), menuBar: FakeHostWorld.display.minY)
                    let n = world.nextWindow
                    world.nextWindow += 1
                    var x = FakeHostWorld.Win(pid: pid, spaces: [world.current], frame: f)
                    x.canFullScreen = false
                    x.resizable = false
                    world.wins[n] = x
                    world.apps[pid]?.windows.append(n)
                    kept.insert(n)
                    auxiliary[pid] = (n, a.lasts.map { now + $0 })
                    note(pid, "auxiliary \(n) at \(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))×\(Int(f.height))")
                } else if let ax = auxiliary[pid], let n = ax.window, let at = ax.closeAt, now + 1e-9 >= at {
                    world.closeWindow(n)
                    auxiliary[pid] = (nil, nil)
                    note(pid, "auxiliary \(n) closed")
                }
            }
            // extraWindow at:<s>
            if case .at(let at)? = s.extraWindow, !extraDone.contains(pid), now - start + 1e-9 >= at, let bundle = world.apps[pid]?.bundle {
                extraDone.insert(pid)
                openExtra(bundle: bundle)
            }
            // autoTerminate
            if let auto = s.autoTerminate {
                if !inUserSpaces(pid).isEmpty { noWindowSince[pid] = nil; continue }
                if noWindowSince[pid] == nil { noWindowSince[pid] = now }
                let none = now - noWindowSince[pid]! + 1e-9
                switch auto {
                case .attempt(let after) where none >= after && !attempted.contains(pid):
                    attempted.insert(pid)
                    note(pid, "terminate attempt: no window in a user Space for \(after) s")
                    world.attemptTermination(pid)
                case .quit(let after) where none >= after:
                    note(pid, "terminate attempt: quitting")
                    world.quitNow(pid)
                case .system where none >= 2:
                    let args = arguments[pid] ?? []
                    let disabled = args.indices.contains { i in args[i] == "-NSDisableAutomaticTermination" && i + 1 < args.count && ["YES", "1", "true"].contains(args[i + 1]) }
                    if !disabled { note(pid, "ended by automatic termination"); world.quitNow(pid) }
                default: break
                }
            }
        }
    }
}

func behaviourWorldTests() {
    switchesParsingTests()
    let id = "test.margin.chameleon.3"
    // A fresh world with one Chameleon stand-in, its windows opening in the current Space (an accessory app's do).
    var keep: [BehaviourWorld] = [] // (the world holds its behaviours weakly)
    func make(_ raw: [String: String]) -> (FakeHostWorld, BehaviourWorld) {
        let w = FakeHostWorld()
        w.launchInCurrent = true
        let b = BehaviourWorld(w)
        b.add(id, raw)
        keep.append(b)
        return (w, b)
    }
    func launch(_ w: FakeHostWorld, _ args: [String] = []) -> pid_t {
        _ = w.launchDockless(bundleId: id, arguments: args)
        return w.running(bundleId: id).first?.pid ?? 0
    }
    // The clock moved by hand, 50 ms at a time (as FakeHostWorld's own sleeps move it).
    func run(_ w: FakeHostWorld, _ b: BehaviourWorld, _ seconds: Double) {
        let end = w.clock + seconds
        while w.clock + 1e-9 < end { w.clock += 0.05; w.advance(); b.tick() }
    }

    // restore
    do {
        let (w, _) = make(["restore": "2:normal"])
        let pid = launch(w)
        let list = w.apps[pid]?.windows ?? []
        check("behaviour restore 2:normal: two windows, neither in full screen, both in the current Space", list.count == 2 && list.allSatisfy { w.wins[$0]?.fullScreen == false && w.wins[$0]?.spaces == [w.current] }, "\(list)")
    }
    do {
        let (w, _) = make(["restore": "1:fullscreen"])
        let pid = launch(w)
        let n = w.apps[pid]?.windows.first ?? 0
        let space = w.wins[n]?.spaces.first ?? 0
        check("behaviour restore 1:fullscreen: its window in full screen in a Space of its own, listed and owned by the app, the app not hidden",
              w.wins[n]?.fullScreen == true && space != FakeHostWorld.marginSpace && w.tiles[space] != nil && w.owner[space] == pid && w.hidden.isEmpty, "\(String(describing: w.wins[n]))")
    }
    do {
        let (w, _) = make(["restore": "3:both"])
        let pid = launch(w)
        let list = w.apps[pid]?.windows ?? []
        check("behaviour restore 3:both: three windows, the first only in full screen", list.count == 3 && list.map { w.wins[$0]?.fullScreen == true } == [true, false, false], "\(list)")
    }
    // windowless
    do {
        let (w, b) = make([:])
        let pid = launch(w)
        w.closeWindow(w.apps[pid]?.windows.first ?? 0)
        run(w, b, 0.1)
        check("behaviour windowless off: a single-window app quits once its last window is closed", w.apps[pid] == nil)
    }
    do {
        let (w, b) = make(["windowless": "YES"])
        let pid = launch(w)
        w.closeWindow(w.apps[pid]?.windows.first ?? 0)
        run(w, b, 1)
        check("behaviour windowless YES: still running with no window", w.apps[pid] != nil && w.apps[pid]?.windows.isEmpty == true)
        let n = b.reopen(pid: pid)
        check("behaviour reopen (a Dock-icon click): a new main window in the current Space", n != nil && w.wins[n ?? 0]?.spaces == [w.current] && b.mainWindow(pid) == n)
    }
    do {
        let (w, b) = make(["windowless": "close:8"])
        let pid = launch(w)
        run(w, b, 7.9)
        let before = w.apps[pid]?.windows.count
        run(w, b, 0.2)
        check("behaviour windowless close:8: its own window closed 8 s after it's first on screen, the app still running", before == 1 && w.apps[pid]?.windows.isEmpty == true && w.apps[pid] != nil, "\(String(describing: before))")
    }
    // autoTerminate
    do {
        let (w, b) = make(["autoTerminate": "attempt:5"])
        let pid = launch(w)
        let n = w.apps[pid]?.windows.first ?? 0
        run(w, b, 3)
        check("behaviour autoTerminate attempt: nothing while its window is in a user Space", w.app(pid: pid) != nil)
        _ = w.move(window: n, to: w.createPrivateSpace() ?? 0) // (parked)
        run(w, b, 4.9)
        let early = w.app(pid: pid) != nil
        run(w, b, 0.2)
        check("behaviour autoTerminate attempt:5: 5 s parked, it attempts termination: NSWorkspace says it quit, its process runs on", early && w.app(pid: pid) == nil && w.processRuns(pid: pid), "\(b.said)")
    }
    do {
        let (w, b) = make(["autoTerminate": "quit:3"])
        let pid = launch(w)
        _ = w.move(window: w.apps[pid]?.windows.first ?? 0, to: w.createPrivateSpace() ?? 0)
        run(w, b, 3.1)
        check("behaviour autoTerminate quit:3: 3 s parked, it really quits", !w.processRuns(pid: pid))
    }
    do {
        let (w, b) = make(["autoTerminate": "system"])
        let pid = launch(w, ["-NSMenuEnableMenuBarAgent", "NO", "-NSDisableAutomaticTermination", "YES"])
        _ = w.move(window: w.apps[pid]?.windows.first ?? 0, to: w.createPrivateSpace() ?? 0)
        run(w, b, 10)
        check("behaviour autoTerminate system: launched with -NSDisableAutomaticTermination YES, parked 10 s: still running", w.processRuns(pid: pid) && w.app(pid: pid) != nil)
        let (w2, b2) = make(["autoTerminate": "system"])
        let pid2 = launch(w2)
        _ = w2.move(window: w2.apps[pid2]?.windows.first ?? 0, to: w2.createPrivateSpace() ?? 0)
        run(w2, b2, 2.1)
        check("behaviour autoTerminate system: without it, ended 2 s after it has no window in a user Space", !w2.processRuns(pid: pid2))
    }
    // dialogMain, noFullScreen, fixedSize
    do {
        let (w, _) = make(["dialogMain": "YES", "noFullScreen": "YES", "fixedSize": "320x480"])
        let pid = launch(w)
        let n = w.apps[pid]?.windows.first ?? 0
        let role = hostRun { await w.window(pid: pid, number: n) }??.role
        let full = hostRun { await w.setFullScreen(pid: pid, window: n, true) }
        check("behaviour dialogMain: its main window is an AXWindow/AXDialog", role == "AXWindow/AXDialog", "\(String(describing: role))")
        check("behaviour noFullScreen: its window can't go full screen", w.wins[n]?.canFullScreen == false && full == false && w.wins[n]?.fullScreen == false)
        check("behaviour fixedSize 320x480: not resizable, that size", w.wins[n]?.resizable == false && w.wins[n]?.frame?.size == CGSize(width: 320, height: 480))
    }
    // ordersOut
    do {
        let (w, b) = make(["ordersOut": "untilActive"])
        let pid = launch(w)
        let n = w.apps[pid]?.windows.first ?? 0
        run(w, b, 2)
        let out = w.wins[n]?.spaces == [] && !w.shows(n)
        _ = hostRun { await w.activate(pid: pid, window: n) }
        run(w, b, 0.1)
        check("behaviour ordersOut untilActive: its window in no Space until the app is activated, then in the current one", out && w.wins[n]?.spaces == [w.current] && w.shows(n))
    }
    do {
        let (w, b) = make(["ordersOut": "after:3"])
        let pid = launch(w)
        let n = w.apps[pid]?.windows.first ?? 0
        run(w, b, 2.9)
        let shown = w.shows(n)
        run(w, b, 0.2)
        let out = w.wins[n]?.spaces == []
        _ = hostRun { await w.activate(pid: pid, window: n) }
        run(w, b, 0.1)
        check("behaviour ordersOut after:3: on screen, ordered out of every Space 3 s after, back at its next activation", shown && out && w.shows(n))
    }
    do {
        let (w, b) = make(["ordersOut": "every:2"])
        let pid = launch(w)
        let n = w.apps[pid]?.windows.first ?? 0
        var outs = 0, wasOut = false
        for _ in 0..<130 { run(w, b, 0.05); let isOut = w.wins[n]?.spaces == []; if isOut && !wasOut { outs += 1 }; wasOut = isOut }
        check("behaviour ordersOut every:2: out of every Space briefly every 2 s (3 times in 6.5 s), the same window", outs == 3 && w.wins[n]?.spaces == [w.current], "\(outs)")
    }
    // replacesWindow
    do {
        let (w, b) = make(["replacesWindow": "every:4"])
        let pid = launch(w)
        let first = w.apps[pid]?.windows.first ?? 0
        run(w, b, 4.05)
        let second = b.mainWindow(pid) ?? 0
        run(w, b, 4.0)
        let third = b.mainWindow(pid) ?? 0
        check("behaviour replacesWindow every:4: a new main window every 4 s at the old one's frame, the old one closed (still listed by the window server, off screen, not by Accessibility)",
              second != first && third != second && w.closedWins.isSuperset(of: [first, second]) && !w.shows(first) && !w.shows(second) && w.apps[pid]?.windows == [third] && w.wins[third]?.frame == FakeHostWorld.defaultFrame && w.wins[third]?.spaces == [w.current], "\(first) \(second) \(third) \(b.said)")
    }
    do {
        let (w, _) = make(["replacesWindow": "twin"])
        let pid = launch(w)
        let list = w.apps[pid]?.windows ?? []
        check("behaviour replacesWindow twin: two windows at the same frame in the same Space", list.count == 2 && w.wins[list[0]]?.frame ?? FakeHostWorld.defaultFrame == w.wins[list[1]]?.frame && w.wins[list[0]]?.spaces == w.wins[list[1]]?.spaces)
    }
    // axBusy, strip (FakeHostWorld's own models, through the switch)
    do {
        let (w, b) = make(["axBusy": "2.5", "strip": "fullscreen"])
        let pid = launch(w)
        let n = w.apps[pid]?.windows.first ?? 0
        let busy = hostRun { await w.setFullScreen(pid: pid, window: n, true) }
        run(w, b, 2.6)
        let taken = hostRun { await w.setFullScreen(pid: pid, window: n, true) }
        let strips = (w.apps[pid]?.windows ?? []).filter { w.wins[$0]?.frame == FakeHostWorld.stripFrame }
        check("behaviour axBusy 2.5: Accessibility's full screen refused for 2.5 s after launch, then taken", busy == false && taken == true && w.wins[n]?.fullScreen == true)
        check("behaviour strip fullscreen: its window in full screen has a full-width 88-tall strip of its own", strips.count == 1, "\(strips)")
    }
    do {
        let (w, b) = make(["strip": "at:6,for:5"])
        let pid = launch(w)
        run(w, b, 6.05)
        let made = (w.apps[pid]?.windows ?? []).contains { w.wins[$0]?.frame == FakeHostWorld.stripFrame }
        run(w, b, 5.0)
        let gone = !(w.apps[pid]?.windows ?? []).contains { w.wins[$0]?.frame == FakeHostWorld.stripFrame }
        check("behaviour strip at:6,for:5: the strip 6 s after launch, gone 5 s later", made && gone)
    }
    // auxiliary
    do {
        let (w, b) = make(["auxiliary": "sidebar,at:1,for:2"])
        let pid = launch(w)
        run(w, b, 1.05)
        let aux = (w.apps[pid]?.windows ?? []).dropFirst().first
        let frame = aux.flatMap { w.wins[$0]?.frame }
        run(w, b, 2.0)
        check("behaviour auxiliary sidebar,at:1,for:2: a 1000×800 window at the display's top left (over Margin's sidebar) 1 s after launch, closed 2 s later",
              frame == CGRect(x: 0, y: 33, width: 1000, height: 800) && w.apps[pid]?.windows.count == 1, "\(String(describing: frame))")
    }
    // extraWindow
    do {
        let (w, b) = make(["extraWindow": "at:7"])
        let pid = launch(w)
        run(w, b, 7.05)
        let byItself = w.apps[pid]?.windows.count == 2
        _ = b.openExtra(bundle: id)
        check("behaviour extraWindow at:7: another window by itself 7 s after launch, and one more on demand", byItself && w.apps[pid]?.windows.count == 3)
    }
    // The hooks: FakeHostWorld's own sleeps (the engine's) play the behaviours too.
    do {
        let (w, b) = make(["replacesWindow": "every:1"])
        let pid = launch(w)
        let first = w.apps[pid]?.windows.first ?? 0
        _ = hostRun { await w.sleep(1.5) }
        check("behaviour world: FakeHostWorld's sleeps move its behaviours on (a window replaced during an engine's wait)", b.mainWindow(pid) != first && w.closedWins.contains(first))
    }
}

func switchesParsingTests() {
    let all = ChameleonSwitches.parse(["restore": "3:both:code", "windowless": "close:8", "autoTerminate": "attempt:5", "dialogMain": "YES", "ordersOut": "after:3",
                                      "replacesWindow": "every:4,twin", "axBusy": "2.5", "strip": "linger", "auxiliary": "300x200+40+60,at:2,for:9,borderless",
                                      "noFullScreen": "1", "fixedSize": "320x480", "extraWindow": "menu"])
    check("chameleon switches: every switch parsed", all.errors.isEmpty && all.on.count == 12, "\(all.errors) \(all.on)")
    check("chameleon switches: their canonical text read back is the same switches", ChameleonSwitches.parse(Dictionary(uniqueKeysWithValues: all.on.map { t -> (String, String) in let p = t.split(separator: "=", maxSplits: 1); return (String(p[0]), String(p[1])) })) == all)
    check("chameleon switches: restore's windows in full screen", all.restore?.fullScreen == [true, false, false] && ChameleonSwitches.parse(["restore": "2:fullscreen"]).restore == .init(count: 2, mode: .fullscreen, via: .system)
          && ChameleonSwitches.parse(["restore": "normal"]).restore?.count == 1)
    check("chameleon switches: off by default, NO and 0 off, a single-window app quits after its last window", ChameleonSwitches.parse([:]) == ChameleonSwitches() && ChameleonSwitches.parse(["dialogMain": "NO", "axBusy": "0"]) == ChameleonSwitches()
          && ChameleonSwitches().quitsAfterLastWindow && !ChameleonSwitches.parse(["windowless": "YES"]).quitsAfterLastWindow)
    let bad = ChameleonSwitches.parse(["restore": "9", "axBusy": "soon", "ordersOut": "sometimes", "strip": "at:6", "fixedSize": "10x10", "autoTerminate": "never"])
    check("chameleon switches: values that don't parse are off and named", bad.restore == nil && bad.axBusy == nil && bad.ordersOut == nil && bad.strip == nil && bad.fixedSize == nil && bad.autoTerminate == nil && bad.errors.count == 6, "\(bad.errors)")
    check("chameleon switches: read from defaults' types (a bool, a number, a string)", ChameleonSwitches.read { k in ["ChameleonDialogMain": NSNumber(value: true), "ChameleonAxBusy": NSNumber(value: 2.5), "ChameleonOrdersOut": "untilActive"][k] }
          == ChameleonSwitches.parse(["dialogMain": "YES", "axBusy": "2.5", "ordersOut": "untilActive"]))
    check("chameleon switches: keys", ChameleonSwitches.key("axBusy") == "ChameleonAxBusy" && ChameleonSwitches.names.count == 12)
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    check("chameleon geometry: the strip across the screen's top under the menu bar, 88 tall", ChameleonSwitches.stripFrame(screen: screen, menuBar: 33) == CGRect(x: 0, y: 33, width: 1512, height: 88))
    check("chameleon geometry: the sidebar auxiliary over the screen's left part, the settings one centred", ChameleonSwitches.auxiliaryFrame(.sidebar, screen: screen, menuBar: 33) == CGRect(x: 0, y: 33, width: 1000, height: 800)
          && ChameleonSwitches.auxiliaryFrame(.settings, screen: screen, menuBar: 33).midX == screen.midX)
    check("chameleon geometry: a fixed size's main frame, top-left coordinates flipped to AppKit's and back", ChameleonSwitches.parse(["fixedSize": "320x480"]).mainFrame(index: 1, screen: screen) == CGRect(x: 290, y: 250, width: 320, height: 480)
          && chameleonFlip(chameleonFlip(CGRect(x: 10, y: 20, width: 30, height: 40), mainScreenHeight: 982), mainScreenHeight: 982) == CGRect(x: 10, y: 20, width: 30, height: 40))
}
