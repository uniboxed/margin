// DEV-HOOK: the dev-only test hook's checks go with it before production (docs/HANDOFF.md §9).
//
// The dev hook (app/engines/webkit/safari/DevHooks.swift) against a fake world: refused with its default off, for any
// profile but Safari's Test A and Test B, and with no names read; each kind routed to the world; its
// caps and faults used only by a Test A/Test B switch of the machine (FakeHandoffWorld,
// handoff-tests.swift). And the log: the switch's summary line, and the machine's other lines, carry no
// page title or address even when the copy's words hold both (Diagnostics.scrub).

import AppKit

// DEV-HOOK
final class FakeDevWorld: DevHookWorld {
    var names: [String: String] = [:] // link → Safari's name
    var shown: WindowKey?
    var switches: [(from: WindowKey, to: String, space: String?)] = []
    var switchRefusal: String?
    var dumps = 0
    var devState = DevHookState()
    func devSafariName(_ link: String) -> String? { names[link] }
    func devSafariLinks(named name: String) -> [String] { names.filter { $0.value == name }.keys.sorted() }
    func devShownWindow() -> WindowKey? { shown }
    func devSwitch(from: WindowKey, to link: String, space: String?) -> String? {
        switches.append((from, link, space))
        return switchRefusal
    }
    var probes: [String] = []
    func devProbe(_ link: String, _ what: String) -> String? { probes.append("\(link) \(what)"); return nil }
    var draftSource: DevDraftSnapshot?
    var draftCalls: [(source: DevDraftSnapshot, done: (JSONObject?, String?) -> Void)] = []
    func devDraftSnapshot() -> DevDraftSnapshot? { draftSource }
    func devObserveDrafts(_ source: DevDraftSnapshot, done: @escaping (JSONObject?, String?) -> Void) { draftCalls.append((source, done)) }
    func devDump() -> [String] {
        dumps += 1
        return ["registry: 1 parked", "  window 2020 (safari:b#20) parked"]
    }
}

func devHooksTests() {
    let echo = Diagnostics.echo
    var said: [String] = []
    Diagnostics.echo = { said.append($0) }
    defer { Diagnostics.echo = echo }

    let a = "safari:s-a", b = "safari:s-b", work = "safari:s-w"
    let shownA = WindowKey(link: a, windowId: 1)
    func setup(_ on: Bool = true) -> (FakeDevWorld, DevHooks, () -> Void) {
        let w = FakeDevWorld()
        w.names = [a: "Test A", b: "Test B", work: "Work"]
        w.shown = shownA
        w.draftSource = DevDraftSnapshot(key: shownA, number: 101, pid: 500, epoch: "connection-a", connection: ObjectIdentifier(w), tabs: [11, 12], handoffs: 0)
        var flag = on
        let hooks = DevHooks(world: w, isOn: { flag })
        return (w, hooks, { flag.toggle() })
    }
    func untouched(_ w: FakeDevWorld) -> Bool { w.switches.isEmpty && w.dumps == 0 && w.devState.isEmpty && w.draftCalls.isEmpty }
    let pid = ["pid": "42"]

    do {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-dev-mapping-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        var options = Shell.Options(); options.harness = true; options.dataRoot = root
        let shell = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
        let profiles = shell.profilesOf("safari")
        profiles.refresh(spaces: ["s-old": ["b"]], linked: [])
        profiles.useBrowserNames([SafariProfile(serverId: "test-b", uuid: "b", name: "Test B", symbol: "", margin: "s-old")])
        profiles.useBrowserNames([SafariProfile(serverId: "test-b", uuid: "b", name: "Test B", symbol: "", margin: "s-current")])
        check("dev hook: historical signing aliases cannot duplicate a current test profile", profiles.browserNames["s-old"]?.name == "Test B"
              && shell.devSafariLinks(named: "Test B") == ["safari:s-current"] && shell.devSafariName("safari:s-old") == nil)
        profiles.useBrowserNames([SafariProfile(serverId: "test-b", uuid: "b", name: "Test B", symbol: "", margin: "s-current"),
                                 SafariProfile(serverId: "other-b", uuid: "other", name: "Test B", symbol: "", margin: "s-other")])
        check("dev hook: two real current profiles remain ambiguous", shell.devSafariLinks(named: "Test B").count == 2)
        shell.switcher.session.noFreeze = .sleep
        check("dev hook: dump exposes the sleep interruption without changing it", shell.devDump().contains("session interruption: sleep") && shell.switcher.session.noFreeze == .sleep)
        shell.switcher.woke()
        check("dev hook: dump distinguishes an allowed wake", shell.devDump().contains("session interruption: none"))
    }

    do {
        let ready: [String: Any] = [kCGSessionOnConsoleKey as String: true, kCGSessionLoginDoneKey as String: true]
        check("live cover session: console and login are required", SessionVisibility.allowsCover(ready)
              && !SessionVisibility.allowsCover(nil) && !SessionVisibility.allowsCover([:]))
        check("live cover session: lock or inactive session refuses", !SessionVisibility.allowsCover(ready.merging(["CGSSessionScreenIsLocked": true]) { _, b in b })
              && !SessionVisibility.allowsCover(ready.merging([kCGSessionOnConsoleKey as String: false]) { _, b in b }))
    }

    // ---- off unless the default says YES, read at each notification ----
    do {
        let (w, hooks, toggle) = setup(false)
        let lines = DevHooks.Kind.allCases.map { hooks.heard($0, ["to": "Test B", "freeze": "off", "step": "park"].merging(pid) { x, _ in x }) }
        check("dev hook: the default off, every kind refused, nothing touched",
              lines.allSatisfy { $0.contains("refused: MarginDevHooks isn't YES (asked by pid 42)") } && untouched(w), "\(lines)")
        check("dev hook: the default off, no switch may use it", !hooks.allows(a, b))
        toggle()
        hooks.heard(.switch, ["to": "Test B"])
        check("dev hook: turned on, the next one honoured (the default read each time)", w.switches.count == 1)
        toggle()
        hooks.heard(.switch, ["to": "Test B"])
        check("dev hook: turned off again, refused", w.switches.count == 1 && (hooks.lines.last ?? "").contains("isn't YES"))
    }
    // ---- only Safari's Test A and Test B ----
    do {
        let (w, hooks, _) = setup()
        w.names = [:]
        let lines = DevHooks.Kind.allCases.filter { $0 != .probe }.map { hooks.heard($0, ["to": "Test B", "old": "keep", "step": "show"]) }
        check("dev hook: no names from Safari (no Full Disk Access): everything refused",
              lines.allSatisfy { $0.contains("refused: the window shown has no name from Safari") } && untouched(w) && !hooks.allows(a, b), "\(lines)")
    }
    do {
        let (w, hooks, _) = setup()
        w.shown = WindowKey(link: work, windowId: 9)
        let lines = DevHooks.Kind.allCases.filter { $0 != .probe }.map { hooks.heard($0, ["to": "Test B", "freeze": "off", "step": "reveal"]) }
        check("dev hook: another profile's window shown: everything refused", lines.allSatisfy { $0.contains("isn't Test A's or Test B's") } && untouched(w), "\(lines)")
        check("dev hook: a switch from another profile may not use it", !hooks.allows(work, b) && !hooks.allows(b, work))
    }
    do {
        let (w, hooks, _) = setup()
        w.shown = nil
        check("dev hook: no window shown: refused", hooks.heard(.switch, ["to": "Test B"]).contains("refused: no window shown") && untouched(w))
    }
    // ---- one bounded observation, independent of the handoff's close permission ----
    do {
        let (w, hooks, _) = setup()
        let nonce = UUID().uuidString
        for bad in [["nonce": nonce], ["nonce": nonce, "pid": "0"], ["nonce": "https://secret.example/private", "pid": "42"]] {
            let line = hooks.heard(.drafts, bad)
            check("dev drafts: invalid correlation refused without echoing fields", line.contains("invalid nonce or caller pid")
                  && !line.contains("secret") && w.draftCalls.isEmpty)
        }
        w.names["safari:duplicate"] = "Test A"
        check("dev drafts: ambiguous current profile refused", hooks.heard(.drafts, ["nonce": nonce, "pid": "42"]).contains("not idle, uniquely named and bound") && w.draftCalls.isEmpty)
        w.names.removeValue(forKey: "safari:duplicate")
        w.draftSource = nil
        check("dev drafts: unavailable source refuses before request", hooks.heard(.drafts, ["nonce": nonce, "pid": "42"]).contains("not idle, uniquely named and bound") && w.draftCalls.isEmpty)
    }
    do {
        let (w, hooks, _) = setup()
        let nonce = UUID().uuidString
        let fields = ["nonce": nonce, "pid": "42"]
        check("dev drafts: exact shown identity dispatched", hooks.heard(.drafts, fields).contains("drafts requested")
              && w.draftCalls.count == 1 && w.draftCalls[0].source == w.draftSource)
        check("dev drafts: only one request pending", hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"]).contains("observation is pending") && w.draftCalls.count == 1)
        w.draftCalls[0].done(["drafts": [], "unknown": [12], "title": "PRIVATE", "url": "https://secret.example/"], nil)
        let line = hooks.lines.last ?? ""
        check("dev drafts: unknown preserved and only numeric metadata logged", line.contains("drafts observed") && line.contains("nonce \(nonce)")
              && line.contains("native 101, pid 500") && line.contains("unknown 1 [12]") && !line.contains("PRIVATE") && !line.contains("secret")
              && w.devState.isEmpty && w.switches.isEmpty)
        check("dev drafts: nonce replay refused after completion", hooks.heard(.drafts, fields).contains("nonce already observed") && w.draftCalls.count == 1)
        hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"])
        w.draftCalls[1].done(nil, "https://secret.example/ PRIVATE")
        check("dev drafts: peer failure releases slot without leaking error", hooks.lines.last?.contains("drafts unavailable") == true
              && !hooks.lines.last!.contains("secret") && !hooks.lines.last!.contains("PRIVATE"))
        hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"])
        check("dev drafts: existing request timeout callback allows a later observation", w.draftCalls.count == 3)
        w.draftCalls[2].done(["drafts": [], "unknown": []], nil)
        check("dev drafts: empty result remains observation, never caps or faults", hooks.lines.last?.contains("drafts 0 [], unknown 0 []") == true && w.devState.isEmpty)
    }
    do {
        let (w, hooks, _) = setup()
        let shownB = WindowKey(link: b, windowId: 2)
        w.shown = shownB
        w.draftSource = DevDraftSnapshot(key: shownB, number: 202, pid: 500, epoch: "connection-b", connection: ObjectIdentifier(w), tabs: [21], handoffs: 0)
        hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"])
        check("dev drafts: Test B's currently shown window is also observed", w.draftCalls.count == 1 && w.draftCalls[0].source.key == shownB)
        hooks.stop()
        check("dev drafts: stop retains one pending request until its existing callback/deadline", hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"]).contains("observation is pending") && w.draftCalls.count == 1)
        let stoppedCount = hooks.lines.count
        w.draftCalls[0].done(["drafts": [], "unknown": []], nil)
        check("dev drafts: stopped callback releases slot without publishing result", hooks.lines.count == stoppedCount)
        hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"])
        let count = hooks.lines.count
        w.draftCalls[0].done(["drafts": [], "unknown": []], nil)
        check("dev drafts: stopped generation cannot clear a newer pending observation", hooks.lines.count == count
              && hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"]).contains("observation is pending") && w.draftCalls.count == 2)
        w.draftCalls[1].done(["drafts": [21], "unknown": []], nil)
        check("dev drafts: actual positive draft remains metadata only", hooks.lines.last?.contains("drafts 1 [21], unknown 0 []") == true && w.devState.isEmpty)
    }
    for change in ["shown", "native", "pid", "epoch", "connection", "tabs", "handoffs", "busy", "name", "duplicate", "flag", "stop"] {
        let (w, hooks, toggle) = setup()
        let source = w.draftSource!
        hooks.heard(.drafts, ["nonce": UUID().uuidString, "pid": "42"])
        switch change {
        case "shown": w.shown = WindowKey(link: b, windowId: 2)
        case "name": w.names[a] = "Work"
        case "duplicate": w.names["safari:duplicate"] = "Test A"
        case "flag": toggle()
        case "stop": hooks.stop()
        case "busy": w.draftSource = nil
        default:
            w.draftSource = DevDraftSnapshot(key: source.key, number: change == "native" ? 102 : source.number,
                pid: change == "pid" ? 501 : source.pid, epoch: change == "epoch" ? "new-connection" : source.epoch,
                connection: change == "connection" ? ObjectIdentifier(hooks) : source.connection, tabs: change == "tabs" ? [11, 13] : source.tabs,
                handoffs: change == "handoffs" ? 1 : source.handoffs)
        }
        let count = hooks.lines.count
        w.draftCalls[0].done(["drafts": [], "unknown": []], nil)
        check("dev drafts: \(change) change invalidates asynchronous result", change == "stop" ? hooks.lines.count == count : hooks.lines.last?.contains("drafts stale") == true)
        check("dev drafts: stale result never grants machine capability", w.devState.isEmpty && w.switches.isEmpty)
    }
    do {
        check("dev drafts: malformed ids cannot become an empty close-looking answer", DevHooks.draftAnswer(["drafts": [], "unknown": [true]], tabs: [1]) == nil
              && DevHooks.draftAnswer(["drafts": [], "unknown": [99]], tabs: [11]) == nil
              && DevHooks.draftAnswer(["drafts": [], "unknown": "PRIVATE"], tabs: [11]) == nil)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-dev-drafts-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        var options = Shell.Options(); options.harness = true; options.dataRoot = root
        let shell = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
        let source = DevDraftSnapshot(key: shownA, number: 101, pid: 500, epoch: "connection", connection: ObjectIdentifier(shell), tabs: [11], handoffs: 0)
        var refused = false
        shell.devObserveDrafts(source) { result, error in refused = result == nil && error == "stale source" }
        check("dev drafts Shell: unbound/unlinked source refused before actual request", shell.devDraftSnapshot() == nil && refused && shell.switcher.session.pending.isEmpty)
        let open: JSONObject = ["tabs": ["12": ["windowId": 1, "url": "https://secret.example/"], "11": ["windowId": 1], "13": ["windowId": 2]]]
        check("dev drafts Shell: metadata identity selects only current window tab ids", Shell.devDraftTabIDs(open, windowId: 1) == [11, 12]
              && Shell.devDraftTabIDs(open, windowId: 2) == [13] && Shell.devDraftTabIDs(open, windowId: 3) == nil
              && Shell.devDraftTabIDs(["tabs": ["bad": ["windowId": 1]]], windowId: 1) == nil)
    }
    // ---- the tab-move probe: Test A's copy only, by Safari's name, whatever window is shown ----
    do {
        let (w, hooks, toggle) = setup(false)
        check("dev hook: probe: refused with the default off", hooks.heard(.probe, ["what": "tabMove"]).contains("isn't YES") && w.probes.isEmpty)
        toggle()
        check("dev hook: probe: only tabMove", hooks.heard(.probe, ["what": "closeAll"]).contains("refused: a probe that isn't tabMove") && w.probes.isEmpty)
        w.shown = WindowKey(link: work, windowId: 9) // another profile's window in front
        check("dev hook: probe: asked of Test A's copy, whatever window is shown", hooks.heard(.probe, ["what": "tabMove"]).contains("probe tabMove in Test A") && w.probes == ["\(a) tabMove"], "\(w.probes)")
        w.names = [b: "Test B", work: "Work"]
        check("dev hook: probe: no profile named Test A: refused", hooks.heard(.probe, ["what": "tabMove"]).contains("0 Safari profiles named Test A") && w.probes.count == 1)
    }
    do {
        let (w, hooks, _) = setup()
        for to in ["Work", "test b", "Test B ", " Test B", "Test C", "https://bank.example/ “Secret”"] {
            let line = hooks.heard(.switch, ["to": to])
            check("dev hook: a target not named exactly Test A or Test B refused (\(to.count) characters), its words not logged",
                  line.contains("refused: a target that isn't exactly Test A or Test B") && !line.contains("bank") && !line.contains("Secret") && !line.contains("Work"), line)
        }
        check("dev hook: no target: refused", hooks.heard(.switch, [:]).contains("refused: a target"))
        check("dev hook: the shown profile as the target: refused", hooks.heard(.switch, ["to": "Test A"]).contains("refused: Test A's window is the one shown"))
        check("dev hook: none of those reached the world", untouched(w))
        w.names["safari:s-b2"] = "Test B"
        check("dev hook: two Safari profiles named Test B: refused", hooks.heard(.switch, ["to": "Test B"]).contains("refused: 2 Safari profiles named Test B") && w.switches.isEmpty)
        check("dev hook: two named Test B: no switch may use it", hooks.allows(a, b) && !hooks.allows(b, "safari:s-b2"))
    }
    do {
        let (w, hooks, _) = setup()
        withExtendedLifetime(w) { // the hook holds its world weakly
            check("dev hook: allows a Test A/Test B switch, both ways", hooks.allows(a, b) && hooks.allows(b, a))
            check("dev hook: not a switch to itself", !hooks.allows(a, a))
        }
    }
    // ---- each kind routed to the world ----
    do {
        let (w, hooks, _) = setup()
        let line = hooks.heard(.switch, ["to": "Test B", "pid": "4242"])
        check("dev hook: switch to Test B from the window shown", w.switches.count == 1 && w.switches[0].from == shownA && w.switches[0].to == b && w.switches[0].space == nil, "\(w.switches)")
        check("dev hook: its line: the name, the window, the pid", line == "dev hook: switch to Test B from safari:s-a#1 (asked by pid 4242)", line)
        hooks.heard(.switch, ["to": "Test B", "space": "sB1"])
        check("dev hook: with a space", w.switches.last?.space == "sB1")
        check("dev hook: a space that isn't a plain id: refused", hooks.heard(.switch, ["to": "Test B", "space": "a/b"]).contains("refused: a space id") && w.switches.count == 2)
        w.switchRefusal = "that profile has no spaces"
        check("dev hook: the shell's refusal said", hooks.heard(.switch, ["to": "Test B"]).contains("refused: that profile has no spaces"))
    }
    do {
        let (w, hooks, _) = setup()
        said = []
        hooks.heard(.dump, pid)
        check("dev hook: dump: the world's lines logged", w.dumps == 1 && said == ["dev hook: dump (asked by pid 42)", "dev hook: dump: registry: 1 parked", "dev hook: dump:   window 2020 (safari:b#20) parked"], "\(said)")
    }
    do {
        let (w, hooks, _) = setup()
        hooks.heard(.mode, ["freeze": "off", "old": "close"])
        check("dev hook: mode caps the session", w.devState.freeze == false && w.devState.old == .close)
        hooks.heard(.mode, ["old": "keep"])
        check("dev hook: mode: one field at a time", w.devState.freeze == false && w.devState.old == .keep)
        hooks.heard(.mode, ["freeze": "on", "old": "park"])
        check("dev hook: mode: on and park are no cap", w.devState.isEmpty)
        hooks.heard(.mode, ["cover": "off"])
        check("dev hook: cover cap is explicit and independent of freeze", w.devState.cover == false && w.devState.freeze == nil && w.devState.description.contains("cover off"))
        hooks.heard(.mode, ["cover": "on"])
        check("dev hook: cover on only removes its subtractive cap", w.devState.isEmpty)
        for bad in [["freeze": "maybe"], ["old": "drop"], ["cover": "maybe"], [:]] {
            check("dev hook: mode with \(bad.keys.sorted()) not known: refused, nothing changed", hooks.heard(.mode, bad).contains("refused") && w.devState.isEmpty)
        }
        hooks.heard(.fail, ["step": "park"])
        hooks.heard(.fail, ["step": "reveal"])
        check("dev hook: fail arms the step", w.devState.fails == [.park, .reveal])
        check("dev hook: fail with a step not known: refused", hooks.heard(.fail, ["step": "close"]).contains("refused: a step") && w.devState.fails.count == 2)
    }
    do {
        let (w, hooks, _) = setup()
        for i in 0..<160 { hooks.heard(.mode, ["cover": i % 2 == 0 ? "off" : "on"]) }
        check("dev hook: long benchmarks retain only bounded recent diagnostics", hooks.lines.count == DevHooks.retainedLineLimit
              && hooks.lines.last?.contains("mode cover on") == true && w.devState.isEmpty)
    }
    // ---- the fields: userInfo's strings, or the extension's JSON string ----
    do {
        let f = DevHooks.fields(object: #"{"to":"Test B","pid":7,"space":"s1"}"#, userInfo: nil)
        check("dev hook: fields from a JSON string object", f == ["to": "Test B", "pid": "7", "space": "s1"], "\(f)")
        let u = DevHooks.fields(object: nil, userInfo: ["to": "Test A", "pid": NSNumber(value: 9), "long": String(repeating: "x", count: 65), "deep": ["x": 1]])
        check("dev hook: fields from userInfo, long or nested values left out", u == ["to": "Test A", "pid": "9"], "\(u)")
    }
    // ---- the caps and the faults ----
    do {
        var st = DevHookState()
        let plain = HandoffChoice(freeze: true, old: .park)
        check("dev hook: no caps: the choice as it was", st.capped(plain) == plain)
        st.freeze = false
        check("dev hook: freeze off", st.capped(plain).description == "park (the dev hook's cap: no freeze)", st.capped(plain).description)
        st.freeze = nil
        st.old = .close
        check("dev hook: old close: park becomes close, the freeze kept", { let c = st.capped(plain); return c.freeze && c.old == .close }())
        st.old = .keep
        check("dev hook: old keep: close becomes keep too", st.capped(HandoffChoice(freeze: true, old: .close)).old == .keep)
        st.old = .close
        check("dev hook: a cap only takes away (keep stays keep)", st.capped(HandoffChoice(freeze: false, old: .keep, why: "its copy isn't linked")).old == .keep)
        st.fails = [.show]
        check("dev hook: a fault used once", st.take(.show) && !st.take(.show) && !st.take(.park))
    }
    devHookMachineTests()
    summaryPrivacyTests()
}

// The machine with the hook's caps and faults: only a switch the hook allows uses them.
private func devHookMachineTests() {
    let toB = ProfileSwitch.Target(profile: hB, space: "b1")
    let toA = ProfileSwitch.Target(profile: hA, space: "a1")
    do {
        // Not allowed (any other profile, or the default off): what's armed stays armed and isn't used.
        let (w, s) = handoffSetup()
        s.session.dev = DevHookState(freeze: false, old: .keep, fails: [.park, .show, .reveal, .fullscreen])
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("dev hook, not allowed: the switch as ever (park+freeze, A parked)", w.events.last == .done(toB) && w.registry.isParked(1010)
              && (s.session.lines.last ?? "").contains("(park+freeze, parked target)") && !(s.session.lines.last ?? "").contains("dev hook"), "\(s.session.lines)")
        check("dev hook, not allowed: nothing used", s.session.dev.fails.count == 4 && s.session.parkOff == nil && s.session.rules.on)
        handoffInvariants("dev hook, not allowed", w, s)
    }
    do {
        let (w, s) = handoffSetup { $0.devAllowed = true }
        s.session.dev.old = .keep
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        let line = s.session.lines.last ?? ""
        check("dev hook: old keep: A untouched in its full-screen Space", w.events.last == .done(toB) && w.win(hKA)?.state == "fullscreen" && !w.registry.isParked(1010)
              && w.types(hA, "setWindowState").isEmpty && line.contains("(keep+freeze, parked target)") && line.contains("A kept (the dev hook's cap: keep)") && line.contains("dev hook: cap"), line)
        handoffInvariants("dev hook: old keep", w, s)
    }
    do {
        let (w, s) = handoffSetup { $0.devAllowed = true }
        s.session.dev.freeze = false
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("dev hook: freeze off: parked, seen", w.events.last == .done(toB) && w.registry.isParked(1010) && w.freezer.calls.isEmpty, "\(w.freezer.calls)")
        handoffInvariants("dev hook: freeze off", w, s)
    }
    do {
        // A's park counted as not landed: no park op, parking off for the session, A closed (no draft).
        let (w, s) = handoffSetup { $0.devAllowed = true }
        s.session.dev.fails = [.park]
        let parkOps = w.reads.calls.filter { $0.hasPrefix("add 1010") }.count
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 6)
        let line = s.session.lines.last ?? ""
        check("dev hook: fail park: no op for A, parking off for the session", w.reads.calls.filter { $0.hasPrefix("add 1010") }.count == parkOps
              && s.session.parkOff?.contains("window 1010's park didn't land") == true && s.session.dev.fails.isEmpty, "\(w.reads.calls) \(s.session.parkOff ?? "-")")
        check("dev hook: fail park: A closed (nothing typed), B in front", w.events.last == .done(toB) && w.win(hKA) == nil && w.fullAndInFront(hKB) && line.contains("dev hook: park"), line)
        handoffInvariants("dev hook: fail park", w, s)
    }
    do {
        // B's show counted as not landed: B stays in its own Space, closed by its copy, and a new window made.
        let (w, s) = handoffSetup { $0.devAllowed = true }
        s.session.dev.fails = [.show]
        let before = w.reads.calls.count // B's own park, in the setup
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 6)
        check("dev hook: fail show: no show op, parking off", !w.reads.calls.dropFirst(before).contains { $0.hasPrefix("add 2020") } && s.session.parkOff?.contains("window 2020's show didn't land") == true, "\(w.reads.calls)")
        check("dev hook: fail show: B closed by its copy, the switch on as a new window", w.types(hB, "closeWindow").count == 1 && w.types(hB, "openSpaceWindow").count == 1
              && w.events.last == .done(toB) && (s.session.lines.last ?? "").contains("new window"), "\(s.session.lines)")
        handoffInvariants("dev hook: fail show", w, s)
    }
    do {
        // B's full-screen request counted as not landed: never sent; the watchdog, then recovery, A back.
        let (w, s) = handoffSetup { $0.devAllowed = true }
        s.session.dev.fails = [.fullscreen]
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 9)
        let line = s.session.lines.last ?? ""
        check("dev hook: fail fullscreen: B never asked, revealed by the watchdog, recovered",
              !w.types(hB, "setWindowState").contains { $0.state == "fullscreen" } && line.contains("late (watchdog at 1700 ms, waiting for B)")
              && line.contains("recovered: Safari’s window didn’t go full screen") && line.contains("dev hook: fullscreen") && failedEvent(w.events.last), line)
        check("dev hook: fail fullscreen: A in front again", w.fullAndInFront(hKA))
        handoffInvariants("dev hook: fail fullscreen", w, s)
    }
    do {
        // The reveal counted as failed: made all the same, then the freeze off for the session.
        let (w, s) = handoffSetup { $0.devAllowed = true }
        s.session.dev.fails = [.reveal]
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        let line = s.session.lines.last ?? ""
        check("dev hook: fail reveal: the screen revealed, the freeze off for the session", w.freezer.calls.contains("reveal 1 ready: 0") && !w.freezer.isLive
              && !s.session.rules.on && line.contains("(result -1)") && line.contains("dev hook: reveal"), "\(w.freezer.calls) \(line)")
        let before = w.freezer.calls.count
        s.start(toA, from: hB, windowId: 20)
        handoffRun(w, 5)
        check("dev hook: fail reveal: the next switch without a freeze", w.freezer.calls.count == before && w.events.last == .done(toA), "\(w.freezer.calls)")
        handoffInvariants("dev hook: fail reveal", w, s)
    }
}

private func failedEvent(_ e: ProfileSwitch.Event?) -> Bool { if case .failed? = e { return true }; return false }

// The switch's lines carry ids, numbers and ms only, even when what the copies say holds a page's title
// and address (a browser's error can name a page).
private func summaryPrivacyTests() {
    let echo = Diagnostics.echo
    var said: [String] = []
    Diagnostics.echo = { said.append($0) }
    defer { Diagnostics.echo = echo }
    let secret = #"Cannot access contents of url "https://bank.example/login?u=nora" (“Bank — Secret Title”) www.bank.example data:text/html,hi"#
    let toB = ProfileSwitch.Target(profile: hB, space: "b1")
    func clean(_ l: String) -> Bool { !["bank.example", "https://", "Secret", "nora", "data:text"].contains { l.contains($0) } }
    do {
        let (w, s) = handoffSetup { w in
            w.errors["\(hB) setWindowState"] = secret
            w.drafts[hKA] = ["drafts": [["tabId": 3, "title": "Bank — Secret Title", "url": "https://bank.example/"]], "unknown": []]
        }
        said = []
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 6)
        let line = s.session.lines.last ?? ""
        check("log: the copy's error reached the summary, scrubbed", line.contains("recovered: Safari didn’t answer (Cannot access contents of url \"…\" (“…”) (an address) (an address))"), line)
        check("log: no title or address in the summary", clean(line), line)
        check("log: no title or address in any line of the switch", said.allSatisfy(clean), "\(said.filter { !clean($0) })")
        handoffInvariants("log: an error with a title and address", w, s)
    }
    do {
        let (w, s) = handoffSetup { w in w.probeAnswer = ["none": secret] }
        s.options.handoff.frameProbe = true
        said = []
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        let line = s.session.lines.last ?? ""
        check("log: a probe's words in the lines, scrubbed", w.events.last == .done(toB) && line.contains("page frames") && clean(line) && said.allSatisfy(clean), "\(said.filter { !clean($0) })")
    }
    do {
        check("scrub: link keys and Margin's words kept", Diagnostics.scrub("handoff: safari:s-a#3 → safari:s-b#7 (park+freeze), A's normal") == "handoff: safari:s-a#3 → safari:s-b#7 (park+freeze), A's normal")
        check("scrub: addresses", Diagnostics.scrub("at file:///Users/x/a.html and about:blank, safari-web-extension://AB/x") == "at (an address) and (an address), (an address)")
        check("scrub: cut at its limit", Diagnostics.scrub(String(repeating: "a", count: 10), max: 4) == "aaaa…")
    }
}
