// The hosting core's stage 3, end to end off screen: every behaviour class of docs/HOSTING-CORE.md, played by the
// stand-in world (behaviour-world.swift's BehaviourWorld over FakeHostWorld, with the real Mac's pacing of full screen,
// `staged`), hosted by the engine through its public API, the shell's poll every 250 ms, and the design's desired state
// read the way the real-screen suite reads it (tools/screen-tests/suite/Behaviours.swift `evaluate`): exactly one main
// window at the page area (inside it for a fixed size), on screen, in Margin's Space only; no other window of the app in
// a user Space (the ones the person keeps aside: an auxiliary, an extra window); no strip on screen; nothing let in
// front of Margin's window over its sidebar, nor a leftover or a strip; Mission Control lists Margin's Space only; and
// that state held. Part of tests.swift's run (`hostBehaviourTests`).
//
// Which of these fail on the engine before the reconciler (the stage-2 tree with these files): DECISIONS.md's entry
// for stage 3 says how it was checked and which.
import AppKit
import Foundation

func hostBehaviourTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-behaviour-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let chameleon = "test.margin.chameleon.3", plain = "test.margin.chameleon.1"
    let margin = FakeHostWorld.marginSpace
    var made = 0

    final class Run {
        let w: FakeHostWorld
        let b: BehaviourWorld
        let e: HostEngine
        var lines: [String] = []
        var letInFront: Int?
        var events: [HostEvent] = []
        init(w: FakeHostWorld, b: BehaviourWorld, e: HostEngine) { self.w = w; self.b = b; self.e = e }
    }
    func make(_ raw: [String: String], _ configure: (FakeHostWorld) -> Void = { _ in }) -> Run {
        made += 1
        let w = FakeHostWorld()
        w.launchInCurrent = true // (an app started with no Dock icon opens its windows in the current Space: Margin's)
        w.staged = true // (full screen as the real Mac paces it: the early path)
        w.autoOnScreen = true // (the on-screen list: the current Space's windows)
        let b = BehaviourWorld(w)
        b.add(chameleon, raw)
        b.add(plain, [:])
        configure(w)
        let e = HostEngine(system: w, marker: folder.appendingPathComponent("\(made)/\(HostMarker.fileName)"), pid: 1, observation: FakeObservation(w))
        e.observer.schedule = { _, run in run() }
        let r = Run(w: w, b: b, e: e)
        e.others = { r.letInFront = $0 }
        e.onEvent = { r.events.append($0) }
        return r
    }
    var keep: [Run] = [] // (the world holds its behaviours weakly)
    func open(_ r: Run, _ bundle: String) -> HostResult? {
        hostRun { await r.e.open(app: .app(bundle), in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: margin) }
    }
    func show(_ r: Run, _ bundle: String) -> HostResult? { hostRun { await r.e.show(HostTarget.app(bundle).id) } }
    // The shell's poll every 250 ms for `seconds`, the stand-in's clock and behaviours moved with it, what the poll asked
    // of the engine's queue run to its end after each (no operation of the test's own in between: the look for other
    // windows tells a window that came with an operation from one the person opened).
    func run(_ r: Run, _ seconds: Double, each: () -> Void = {}) {
        var t = 0.0
        while t < seconds - 1e-9 {
            r.w.clock += 0.25
            r.w.advance()
            r.b.tick()
            r.e.poll()
            let until = Date().addingTimeInterval(5)
            var calm = 0
            while calm < 5, Date() < until {
                RunLoop.main.run(until: Date().addingTimeInterval(0.001))
                calm = r.e.busy ? 0 : calm + 1
            }
            each()
            t += 0.25
        }
    }
    // The desired state, as the suite reads it (numbers only). `framed`: inside the page area is enough.
    func desired(_ r: Run, _ bundle: String, framed: Bool = false) -> (ok: Bool, why: String) {
        // (Its process, whatever NSWorkspace says: an app that attempted termination runs on.)
        guard let pid = r.w.apps.values.first(where: { $0.bundle == bundle })?.pid, r.w.processRuns(pid: pid) else { return (false, "not running") }
        let w = r.w
        func b(_ n: Int) -> CGRect { w.bounds(window: n) ?? .zero }
        func isStrip(_ n: Int) -> Bool { b(n).height <= 120 && b(n).width >= 0.8 * FakeHostWorld.display.width }
        func inUser(_ n: Int) -> Bool { w.wins[n].map { $0.priv == nil && !$0.spaces.isEmpty } ?? false }
        let windows = (w.apps[pid]?.windows ?? []).sorted()
        let mainKind = windows.filter { b($0).width >= 200 && b($0).height >= 200 && !isStrip($0) }
        let mains = mainKind.filter { n in
            !r.b.kept.contains(n) && w.shows(n) && w.spaces(window: n) == [margin] && (framed ? page.insetBy(dx: -2, dy: -2).contains(b(n)) : HostLayout.near(b(n), page, within: 2))
        }
        var problems: [String] = []
        if mains.count != 1 { problems.append("\(mains.count) main windows at the page area (\(windows.map { "\($0) \(Int(b($0).minX)),\(Int(b($0).minY)) \(Int(b($0).width))×\(Int(b($0).height)) \(w.shows($0) ? "on" : "off") \(w.wins[$0].map { $0.priv != nil ? "parked" : "\($0.spaces)" } ?? "?")" }))") }
        let leftovers = mainKind.filter { $0 != mains.first && !r.b.kept.contains($0) && inUser($0) }
        if !leftovers.isEmpty { problems.append("leftovers in user Spaces \(leftovers)") }
        let strips = windows.filter { isStrip($0) && w.shows($0) }
        if !strips.isEmpty { problems.append("strips on screen \(strips)") }
        if let f = r.letInFront {
            let side = CGRect(x: FakeHostWorld.display.minX, y: FakeHostWorld.display.minY, width: page.minX - FakeHostWorld.display.minX, height: FakeHostWorld.display.height)
            let i = b(f).intersection(side)
            if !r.b.kept.contains(f) || (!i.isNull && i.width > 8 && i.height > 8) { problems.append("\(f) let in front of Margin's window") }
        }
        if !w.listsMarginOnly { problems.append("Mission Control lists \(w.tiles.keys.sorted())") }
        if w.frozen { problems.append("the screen frozen") }
        return (problems.isEmpty, problems.isEmpty ? "main \(mains[0])" : problems.joined(separator: "; "))
    }
    // The desired state at every poll for `seconds` (`except`: reads to leave out, the moment after an app's own change).
    func held(_ r: Run, _ bundle: String, _ seconds: Double, framed: Bool = false, except: (Run) -> Bool = { _ in false }) -> (ok: Bool, why: String) {
        var reads = 0, good = 0
        var first: String?
        run(r, seconds) {
            guard !except(r) else { return }
            reads += 1
            let d = desired(r, bundle, framed: framed)
            if d.ok { good += 1 } else if first == nil { first = String(format: "%.2f: ", r.w.clock) + d.why }
        }
        return (good == reads && reads > 0, "\(good) of \(reads) reads\(first.map { "; first miss \($0)" } ?? "")")
    }
    func listen(_ r: Run) -> () -> Void {
        let echo = Diagnostics.echo
        Diagnostics.echo = { r.lines.append($0); echo?($0) }
        return { Diagnostics.echo = echo }
    }
    func said(_ r: Run, _ what: String) -> Int { r.lines.filter { $0.contains(what) }.count }
    // A scenario: Chameleon 1 shown plain first (what a park shows instead), then Chameleon 3 with the switches.
    func scenario(_ raw: [String: String], _ configure: (FakeHostWorld) -> Void = { _ in }) -> (Run, HostResult?) {
        let r = make(raw, configure)
        keep.append(r)
        let done = listen(r)
        _ = open(r, plain)
        let result = open(r, chameleon)
        run(r, 1)
        done()
        return (r, result)
    }
    func finish(_ r: Run) {
        hostRun { await r.e.quitAll() }
        r.w.clock += 1
        r.w.advance()
    }
    let shown = { (r: HostResult?) -> Bool in if case .shown? = r { return true }; return false }

    // ---- restore: windows restored at launch, beside the one Margin hosts: leftovers, parked out of sight ----
    for (switchValue, name) in [("2:normal", "restore-normal"), ("1:fullscreen", "restore-fullscreen"), ("3:both", "restore-both"), ("2:fullscreen", "restore-fullscreen ×2")] {
        let (r, result) = scenario(["restore": switchValue])
        let d = desired(r, chameleon)
        let h = held(r, chameleon, 5)
        check("behaviour \(name): shown, its restored windows out of sight (parked), Mission Control Margin's Space only: \(d.why)", shown(result) && d.ok, "\(String(describing: result)) \(r.lines.filter { $0.contains("→") })")
        check("behaviour \(name): held 5 s: \(h.why)", h.ok)
        let pid = r.w.running(bundleId: chameleon).first?.pid ?? 0
        let count = r.w.apps[pid]?.windows.count ?? 0
        let given = Set(r.w.apps[pid]?.windows ?? []).subtracting(r.e.hosts.values.map(\.window))
        r.w.calls = []
        finish(r)
        check("behaviour \(name): its restored windows parked, never closed (its app keeps its windows at quit), given back to its Desktop before its app is asked to quit; nothing left",
              count == Int(switchValue.prefix(1)) && given.allSatisfy { n in r.w.calls.contains("move \(n) \(FakeHostWorld.desktop)") } && r.w.apps[pid] == nil && r.w.privates.isEmpty && r.w.listsMarginOnly,
              "\(count) \(given) \(r.w.calls) \(r.w.privates)")
    }
    do {
        // Its app discarding its windows at quit (macOS's default): a restored window made before the one Margin hosts
        // closed by its own close button; one made after it parked (it may be the app's real main window).
        let (r, result) = scenario(["restore": "2:normal"]) { $0.keepsWindows = [] }
        r.w.keepsWindows = [] // (BehaviourWorld's restore sets it at the launch)
        let pid = r.w.running(bundleId: chameleon).first?.pid ?? 0
        let hosted = r.e.hosts[HostTarget.app(chameleon).id]?.window ?? 0
        let others = (r.w.apps[pid]?.windows ?? []).filter { $0 != hosted }
        let d = desired(r, chameleon)
        check("behaviour restore-normal, its app discarding windows at quit: shown, its restored window out of sight: \(d.why)", shown(result) && d.ok, "\(others)")
        finish(r)
    }
    // ---- windowless: its own window closed 8 s after it's shown, the app runs on with none: reopened, the new one adopted ----
    do {
        let (r, result) = scenario(["windowless": "close:8"])
        let done = listen(r)
        run(r, 9)
        let d = desired(r, chameleon)
        let h = held(r, chameleon, 5)
        done()
        check("behaviour windowless: its window closed by its app, its app still running: reopened (a Dock-icon click), the window it made adopted, at the page area: \(d.why)",
              shown(result) && d.ok && said(r, "→ reopen") >= 1 && said(r, "adopted in place of") == 1 && !r.events.contains(.windowClosed(HostTarget.app(chameleon).id)), "\(r.lines.filter { $0.contains("→") || $0.contains("adopted") })")
        check("behaviour windowless: held 5 s: \(h.why)", h.ok)
        finish(r)
    }
    // ---- autoTerminate: parked 15 s, it attempts termination (or AppKit's is on): still hosted, still Margin's, a switch back ----
    for value in ["attempt:5", "system"] {
        let (r, result) = scenario(["autoTerminate": value])
        _ = show(r, plain)
        run(r, 15)
        let running = r.w.running(bundleId: chameleon).first.map { r.w.processRuns(pid: $0.pid) } ?? (r.w.apps.values.contains { $0.bundle == chameleon })
        let t0 = r.w.clock
        let back = show(r, chameleon)
        let took = r.w.clock - t0
        let d = desired(r, chameleon)
        check("behaviour autoTerminate \(value): parked 15 s: still running, still hosted; shown again by a switch (\(Int(took * 1000)) ms): \(d.why)",
              shown(result) && running && shown(back) && took < 0.1 && d.ok, "\(String(describing: back)) \(running)")
        finish(r)
    }
    // ---- dialogMain, axBusy, auxiliary: shown as the design wants (these passed before the reconciler too) ----
    for (raw, name) in [(["dialogMain": "YES"], "dialogMain"), (["axBusy": "2.5"], "axBusy"), (["auxiliary": "settings"], "auxiliary-settings"), (["auxiliary": "sidebar,at:3"], "auxiliary-sidebar")] {
        let (r, result) = scenario(raw)
        run(r, name == "axBusy" ? 3 : 4)
        let d = desired(r, chameleon)
        let h = held(r, chameleon, 5)
        check("behaviour \(name): shown at the page area, nothing of it over the sidebar in front of Margin's window: \(d.why)", shown(result) && d.ok, "\(String(describing: result))")
        check("behaviour \(name): held 5 s: \(h.why)", h.ok)
        finish(r)
    }
    // ---- ordersOut untilActive: its window never ordered in until its app is activated: brought forward, then hosted ----
    do {
        let (r, result) = scenario(["ordersOut": "untilActive"])
        let d = desired(r, chameleon)
        let h = held(r, chameleon, 5)
        check("behaviour ordersOut untilActive: its window not listed by Accessibility until its app is brought forward: activated, found, hosted: \(d.why)",
              shown(result) && d.ok && said(r, "→ bring forward (activate)") == 1, "\(String(describing: result)) \(r.lines.filter { $0.contains("bring forward") || $0.contains("failed") })")
        check("behaviour ordersOut untilActive: held 5 s: \(h.why)", h.ok)
        finish(r)
    }
    // ---- ordersOut after:3: its shown window ordered out 3 s after it's on screen: back in sight, the same window ----
    do {
        let (r, result) = scenario(["ordersOut": "after:3"])
        run(r, 5)
        let d = desired(r, chameleon)
        let h = held(r, chameleon, 5)
        check("behaviour ordersOut after:3: ordered out by its app while shown: on screen again, still hosted: \(d.why)", shown(result) && d.ok, "\(r.lines.suffix(6))")
        check("behaviour ordersOut after:3: held 5 s: \(h.why)", h.ok)
        finish(r)
    }
    // ---- replacesWindow every:4: a new main window every 4 s, the old one closed: adopted each time, never fought ----
    do {
        let (r, result) = scenario(["replacesWindow": "every:4"])
        let done = listen(r)
        let pid = r.w.running(bundleId: chameleon).first?.pid ?? 0
        // (The moment between its app's replacement and its adoption, a poll's: left out, as the suite does.)
        let h = held(r, chameleon, 13) { r in (r.b.replacedAt[pid]).map { r.w.clock - $0 < 0.55 } ?? false }
        done()
        check("behaviour replacesWindow every:4: each new window adopted in place of the old one (\(said(r, "adopted in place of")) times), the desired state between: \(h.why)",
              shown(result) && h.ok && said(r, "adopted in place of") >= 3 && r.e.isHosted(HostTarget.app(chameleon).id), "\(r.lines.filter { $0.contains("adopt") || $0.contains("→") }.suffix(6))")
        finish(r)
    }
    // ---- replacesWindow twin: a second window at its main one's frame from its launch: a leftover, parked ----
    do {
        let (r, result) = scenario(["replacesWindow": "twin"])
        let d = desired(r, chameleon)
        let h = held(r, chameleon, 5)
        check("behaviour replacesWindow twin: its twin made as it launched: parked out of sight, never let in front: \(d.why)", shown(result) && d.ok, "\(r.lines.filter { $0.contains("→") })")
        check("behaviour replacesWindow twin: held 5 s: \(h.why)", h.ok)
        finish(r)
    }
    // ---- strip: a full-width strip of its own while it's in full screen (left after an exit): parked, never seen ----
    do {
        let (r, result) = scenario(["strip": "linger"])
        let d = desired(r, chameleon)
        let h = held(r, chameleon, 5)
        check("behaviour strip linger: its full-width strip out of sight (parked), its window at the page area: \(d.why)", shown(result) && d.ok && said(r, "→ park strip") >= 1, "\(r.lines.filter { $0.contains("strip") })")
        check("behaviour strip linger: held 5 s: \(h.why)", h.ok)
        finish(r)
    }
    // ---- noFullScreen, fixedSize: window mode, its window off screen in Margin's Space until its app is reopened (one
    // hypothesis of the real Mac's): brought forward a rung at a time, on screen; never: the predictable fallback ----
    for (raw, name, framed) in [(["noFullScreen": "YES"], "noFullScreen", false), (["noFullScreen": "YES", "fixedSize": "400x300"], "fixedSize", true)] {
        let (r, result) = scenario(raw) { $0.windowedHiddenInFullScreen = true; $0.reopenShows = true }
        let done = listen(r)
        run(r, 3)
        let d = desired(r, chameleon, framed: framed)
        let h = held(r, chameleon, 5, framed: framed)
        done()
        check("behaviour \(name): window mode, off screen in Margin's Space: brought forward (activated, then a Dock-icon click), on screen inside the page area: \(d.why)",
              shown(result) && r.e.mode(of: HostTarget.app(chameleon).id) == .window && d.ok && said(r, "→ bring forward (reopen)") == 1, "\(r.lines.filter { $0.contains("→") || $0.contains("screen") })")
        check("behaviour \(name): held 5 s: \(h.why)", h.ok)
        finish(r)
    }
    do {
        let (r, result) = scenario(["noFullScreen": "YES"]) { $0.windowedHiddenInFullScreen = true }
        let done = listen(r)
        run(r, 4)
        done()
        let id = HostTarget.app(chameleon).id
        let n = r.e.hosts[id]?.window ?? 0
        check("behaviour noFullScreen, never on screen in Margin's Space: the rungs tried once each, then the fallback within its budget: parked, nothing shown, the item kept, the show said failed; nothing moved but into its private Space",
              shown(result) && r.e.shown == nil && r.e.isHosted(id) && r.w.wins[n]?.priv != nil && r.events.contains(.unshown(id)) && r.events.contains { if case .failed(id, .windowMode, _) = $0 { return true }; return false }
              && r.lines.filter({ $0.contains("→ fallback") }).count == 1 && r.lines.filter({ $0.contains("→ bring forward") }).count == 2,
              "\(r.events) \(r.lines.filter { $0.contains("→") })")
        finish(r)
    }
    // ---- extraWindow: another window opened on demand (the menu): the person's, kept beside, never over the sidebar in front ----
    do {
        let (r, result) = scenario(["extraWindow": "menu"])
        _ = r.b.openExtra(bundle: chameleon)
        let h = held(r, chameleon, 5)
        check("behaviour extraWindow: its extra window (the person's, over the sidebar) kept behind Margin's window, the main one at the page area: \(h.why)", shown(result) && h.ok, "\(String(describing: r.letInFront))")
        finish(r)
    }
}
