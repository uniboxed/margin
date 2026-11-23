// Every pane of a split draws active (PanesActive.swift, PaneRecords.swift), part of tests.swift's run: the records'
// bytes and their launch check (against the window server's own records of public events, as read on macOS 27.2.1);
// the part's own launch check (HostCalls); the keeper's steps (a pane of another app kept, the front app's never, one
// window per app, the front app changing both ways, Margin in front, another app in front, a card open, the grace, an
// app quitting, nothing sent at rest, the loop's guard); and the engine on the stand-in world: what's sent for a split,
// re-asserted on a front change, a kept app made the front one by the window server, let go on every exit path (the
// split ended, the pane gone, another app in front, its app quit, Margin quits, a crash: the marker and the next
// launch), and its cost per step. The pane click tap's side is pane-click-tests.swift's (`paneClickKeptTests`).
import AppKit
import Foundation

func panesActiveTests() {
    panesActiveRecordTests()
    panesActiveCallsTests()
    panesActiveKeeperTests()
    panesActiveEngineTests()
}

// The window server's record of an AppKit-defined event (subtype 1, window 0x1234, data1 0x55, data2 0x66) made by
// NSEvent and read with SLEventRecordPointer on macOS 27.2.1 (26B131), 2026-11-21 (allfocus/ctl evdump): its first 0xa0
// bytes (the rest zero).
private let appKitRecordHex = """
00 00 00 00 f8 00 00 00 0d 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 b0 8e 40
00 00 00 00 00 00 00 00 00 00 00 00 00 b0 8e 40
00 00 00 00 00 00 00 00 00 00 00 00 34 12 00 00
00 00 00 00 00 00 00 00 81 71 01 00 f5 01 00 00
14 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 3f 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 01 00 55 00 00 00
66 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
"""

private func bytes(_ hex: String) -> [UInt8] {
    let digits = Array(hex.filter { $0.isHexDigit })
    var out: [UInt8] = []
    var i = 0
    while i + 1 < digits.count { out.append(UInt8(String(digits[i...i + 1]), radix: 16)!); i += 2 }
    return out + [UInt8](repeating: 0, count: max(0, 0xf8 - out.count))
}

private func panesActiveRecordTests() {
    let act = PaneRecords.activation(window: 0x1_2345, activated: true), deact = PaneRecords.activation(window: 0x1_2345, activated: false)
    check("panes active: records: 0x100 bytes, zeroed, saying 0xf8", act.count == 0x100 && act[4] == 0xf8 && act[0xf8...].allSatisfy { $0 == 0 })
    check("panes active: records: activated is an AppKit-defined event (13) for its window, subtype 1; deactivated subtype 2",
          act[8] == 13 && PaneRecords.int32(act, at: 0x3c) == 0x1_2345 && act[0x8a] == 1 && deact[0x8a] == 2 && deact[8] == 13
          && act.enumerated().allSatisfy { [4, 8, 0x3c, 0x3d, 0x3e, 0x8a].contains($0.offset) || $0.element == 0 })
    let down = PaneRecords.makeKey(window: 77, down: true), up = PaneRecords.makeKey(window: 77, down: false)
    check("panes active: records: the make-key pair: a left press (1) and release (2) in its window, byte 0x3a 0x10, its location unset (0xff × 16)",
          down[8] == 1 && up[8] == 2 && down[0x3a] == 0x10 && up[0x3a] == 0x10 && PaneRecords.int32(down, at: 0x3c) == 77
          && down[0x20..<0x30].allSatisfy { $0 == 0xff } && down[4] == 0xf8)

    // The launch check against the window server's own record (its bytes as read on the real Mac), the window patched to
    // the probe's, and mouse records made to the same layout.
    var real = bytes(appKitRecordHex)
    for i in 0..<4 { real[0x3c + i] = UInt8(truncatingIfNeeded: PaneRecords.probeWindow >> (8 * i)) }
    check("panes active: (the fixture: the real record's type, subtype and data where the layout says)", real[8] == 13 && real[0x8a] == 1 && real[0x8c] == 0x55 && real[0x90] == 0x66 && real.count == 0xf8)
    var press = [UInt8](repeating: 0, count: 0xf8), release = press
    for r in [0, 1] {
        var b = [UInt8](repeating: 0, count: 0xf8)
        b[4] = 0xf8
        b[8] = r == 0 ? 1 : 2
        for i in 0..<4 { b[0x3c + i] = UInt8(truncatingIfNeeded: PaneRecords.probeWindow >> (8 * i)) }
        if r == 0 { press = b } else { release = b }
    }
    check("panes active: launch check: the layout as read on macOS 27.2.1: passes", PaneRecords.problem(appKit: real, down: press, up: release) == nil,
          PaneRecords.problem(appKit: real, down: press, up: release) ?? "")
    var moved = real
    moved[0x3c] = 0; moved[0x3d] = 0
    moved[0x40] = UInt8(PaneRecords.probeWindow & 0xff); moved[0x41] = UInt8(PaneRecords.probeWindow >> 8)
    let p1 = PaneRecords.problem(appKit: moved, down: press, up: release)
    check("panes active: launch check: the window's number elsewhere: off, said", p1?.contains("window at 0x3c") == true, p1 ?? "nil")
    var sub = real
    sub[0x8a] = 0; sub[0x8b] = 1
    check("panes active: launch check: the subtype elsewhere: off", PaneRecords.problem(appKit: sub, down: press, up: release)?.contains("subtype") == true)
    var long = press
    long[4] = 0xf0
    check("panes active: launch check: another length: off", PaneRecords.problem(appKit: real, down: long, up: release)?.contains("length") == true)
    var type = release
    type[8] = 1
    check("panes active: launch check: a release whose type isn't 2: off", PaneRecords.problem(appKit: real, down: press, up: type)?.contains("type") == true)
    check("panes active: launch check: a record that didn't read, or a short one: off",
          PaneRecords.problem(appKit: nil, down: press, up: release) != nil && PaneRecords.problem(appKit: Array(real.prefix(0x80)), down: press, up: release) != nil)
    check("panes active: launch check: never the real SLEventRecordPointer under the tests", HostCalls.recordsProblem(HostFakeResolver()) == "SLEventRecordPointer missing")
}

private func panesActiveCallsTests() {
    let base = PrivateCalls.evaluate(FakePrivateResolver())
    let all = HostCalls.evaluate(HostFakeResolver(), base: base)
    check("panes active: calls: all there: on", all.panesActive && all.reasons["panes active"] == nil, "\(all)")
    for (name, framework) in HostCalls.activeFunctions.map({ ($0, PrivateFramework.skyLight) }) + HostCalls.processFunctions.map({ ($0, PrivateFramework.hiServices) }) {
        let r = HostFakeResolver()
        r.functions.remove(name)
        let a = HostCalls.evaluate(r, base: base)
        check("panes active: calls: no \(name) (\(framework.rawValue)): off, the host and the rest on", a.host && a.tiles && a.opens && !a.panesActive && a.reasons["panes active"] == "\(name) missing"
              && a.line(build: "b").hasSuffix("panes active off: \(name) missing"), "\(a)")
    }
    do {
        let r = HostFakeResolver()
        r.frameworks.remove(.hiServices)
        let a = HostCalls.evaluate(r, base: base)
        check("panes active: calls: HIServices not opened: off", a.host && !a.panesActive && (a.reasons["panes active"] ?? "").contains("HIServices.framework didn't open"), "\(a)")
        let r2 = HostFakeResolver()
        r2.functions.remove(HostCalls.skyFunctions[1])
        check("panes active: calls: the host off: off with it", !HostCalls.evaluate(r2, base: base).panesActive && HostCalls.evaluate(r2, base: base).reasons["panes active"] == "the host is off")
    }
    // The wrappers refuse under the tests (nothing posted, nothing read, nobody made the front one).
    let calls = HostPrivate(resolver: HostFakeResolver(), availability: all)
    check("panes active: calls: the wrappers refuse under MARGIN_APP_TESTS", calls.hasPanesActive && calls.refuses && calls.post(PaneRecords.activation(window: 1, activated: true), to: getpid()) == nil
          && calls.frontProcess() == nil && !calls.setFront(pid: getpid(), window: 1))
}

private let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
private func pane(_ pid: pid_t, _ window: Int, x: CGFloat = 0, card: Bool = false) -> PaneClickScene.Pane {
    PaneClickScene.Pane(rect: CGRect(x: 276 + x, y: 41, width: 300, height: 933), pid: pid, window: window, card: card)
}

private func panesActiveKeeperTests() {
    let margin: pid_t = 1, a: pid_t = 501, b: pid_t = 502, c: pid_t = 503, other: pid_t = 900
    var now = 100.0
    var allowedOut: Set<pid_t> = []
    func step(_ k: PanesActiveKeeper, _ panes: [PaneClickScene.Pane], focused: Int?, front: pid_t?) -> [String] {
        k.step(panes: panes, focused: focused, front: front, margin: margin, hosted: { [a, b, c].contains($0) }, allowed: { !allowedOut.contains($0.pid) }, now: now).map(\.description)
    }
    let split = [pane(a, 10), pane(b, 20, x: 310)]
    do {
        let k = PanesActiveKeeper()
        check("panes active: keeper: a split of two apps, the left one's in front: the right one's window kept active", step(k, split, focused: 10, front: a) == ["keep 502 20"] && k.kept == [b: 20])
        check("panes active: keeper: …the same again: nothing sent (at rest: never a record twice)", step(k, split, focused: 10, front: a).isEmpty && step(k, split, focused: 10, front: a).isEmpty)
        // A press on the right pane: its app the front one (the tap's word and NSWorkspace's): the left one's kept.
        k.heardFront(b)
        check("panes active: keeper: the right pane's app made the front one: it's dropped (active for real, nothing sent), the left one's kept",
              step(k, split, focused: 20, front: b) == ["keep 501 10"] && k.kept == [a: 10])
        k.heardFront(a)
        check("panes active: keeper: …and back: the right one's kept again (the window server deactivated it)", step(k, split, focused: 10, front: a) == ["keep 502 20"] && k.kept == [b: 20])
        // Both made the front one between two steps (A → B → A): B was deactivated meanwhile, kept again.
        k.heardFront(b)
        k.heardFront(a)
        check("panes active: keeper: the other app in front and back between two steps: kept again (deactivated meanwhile)", step(k, split, focused: 10, front: a) == ["keep 502 20"])
        check("panes active: keeper: the marker's apps: both of the split (each sent active once, still in it: no write per click)", Set(k.touched.keys) == [a, b], "\(k.touched)")
        // Margin in front (its palette, a menu): the focused pane's app counts as the front one: nothing changes.
        check("panes active: keeper: Margin in front: the focused pane's app counts as the front one, nothing sent", step(k, split, focused: 10, front: margin).isEmpty && k.kept == [b: 20])
        k.heardFront(a)
        check("panes active: keeper: …the keys back to it: nothing sent", step(k, split, focused: 10, front: a).isEmpty && k.kept == [b: 20])
        // The front one unread: the focused pane's app.
        check("panes active: keeper: the front app unread: the focused pane's app taken for it, nothing sent", step(k, split, focused: 10, front: nil).isEmpty)
        // Another app (not hosted) in front: let go at once.
        check("panes active: keeper: another app in front (not one Margin hosts): let go at once", step(k, split, focused: 10, front: other) == ["release 502 20"] && k.kept.isEmpty && k.touched.isEmpty)
        check("panes active: keeper: …and while it is: nothing kept", step(k, split, focused: 10, front: other).isEmpty)
        k.heardFront(a)
        check("panes active: keeper: …back to the split: kept again", step(k, split, focused: 10, front: a) == ["keep 502 20"])
        // A hosted app outside the split in front (a newcomer's open): not another app; the focused pane's app counts.
        check("panes active: keeper: a hosted app outside the split in front (a pane's newcomer): kept as they are", step(k, split, focused: 10, front: c).isEmpty && k.kept == [b: 20])
    }
    // Same app twice.
    do {
        let k = PanesActiveKeeper()
        let three = [pane(a, 10), pane(a, 11, x: 310), pane(b, 20, x: 620)]
        check("panes active: keeper: two panes of the front app and one of another: only the other's kept (one key window per app: the front app's second pane never)",
              step(k, three, focused: 10, front: a) == ["keep 502 20"])
        let k2 = PanesActiveKeeper()
        let twoB = [pane(a, 10), pane(b, 20, x: 310), pane(b, 21, x: 620)]
        check("panes active: keeper: two panes of another app: one of them kept (its frontmost)", step(k2, twoB, focused: 10, front: a) == ["keep 502 21"])
        k2.heardFront(b)
        _ = step(k2, twoB, focused: 20, front: b)
        k2.heardFront(a)
        check("panes active: keeper: …its other pane focused last: that one kept from then", step(k2, twoB, focused: 10, front: a) == ["keep 502 20"])
        // Its key pane changes while it stays kept (the layout swaps which of its windows shows): moved.
        let swapped = [pane(a, 10), pane(b, 22, x: 310)]
        check("panes active: keeper: an app kept, its pane now another of its windows: moved (deactivated, then the new one activated and key)",
              step(k2, swapped, focused: 10, front: a) == ["move 502 20→22"] && k2.kept == [b: 22])
    }
    // Three apps.
    do {
        let k = PanesActiveKeeper()
        let three = [pane(a, 10), pane(b, 20, x: 310), pane(c, 30, x: 620)]
        check("panes active: keeper: three apps: both others kept", step(k, three, focused: 20, front: b) == ["keep 501 10", "keep 503 30"])
        k.heardFront(c)
        check("panes active: keeper: …the third clicked: only the one that had the keys kept anew", step(k, three, focused: 30, front: c) == ["keep 502 20"] && k.kept == [a: 10, b: 20])
    }
    // The grace: the split's panes gone for a moment (a layout's change), then for good.
    do {
        let k = PanesActiveKeeper()
        _ = step(k, split, focused: 10, front: a)
        check("panes active: keeper: the scene gone (a layout's change): nothing sent yet, a step due at the grace", step(k, [], focused: nil, front: a).isEmpty && k.due == now + 1)
        now += 0.5
        check("panes active: keeper: …back within the grace: nothing sent, nothing due", step(k, split, focused: 10, front: a).isEmpty && k.due == nil && k.kept == [b: 20])
        check("panes active: keeper: one host left (the split ended)", step(k, [pane(a, 10)], focused: 10, front: a).isEmpty && k.due == now + 1)
        now += 0.6
        check("panes active: keeper: …not yet", step(k, [pane(a, 10)], focused: 10, front: a).isEmpty)
        now += 0.5
        check("panes active: keeper: …its grace over: let go (deactivated), the marker's entry with it", step(k, [pane(a, 10)], focused: 10, front: a) == ["release 502 20"] && k.kept.isEmpty && k.touched.isEmpty && k.due == nil)
    }
    // A card open over the split: nothing kept or let go for it.
    do {
        let k = PanesActiveKeeper()
        _ = step(k, split, focused: 10, front: a)
        let card = [pane(a, 40, card: true)]
        check("panes active: keeper: a preview card open (only its page in the scene): the split's apps left as they are", step(k, card, focused: 40, front: a).isEmpty && k.kept == [b: 20] && k.due == nil)
        now += 5
        check("panes active: keeper: …however long", step(k, card, focused: 40, front: a).isEmpty && k.kept == [b: 20])
        check("panes active: keeper: …closed: nothing sent", step(k, split, focused: 10, front: a).isEmpty)
        check("panes active: keeper: a card open, another app in front: let go", step(k, card, focused: 40, front: other) == ["release 502 20"])
    }
    // Its app can't be kept (quitting), its app quit, everything let go.
    do {
        let k = PanesActiveKeeper()
        _ = step(k, split, focused: 10, front: a)
        allowedOut = [b]
        check("panes active: keeper: its pane not shown for a moment (an operation moving its window): nothing sent yet, due at the grace",
              step(k, split, focused: 10, front: a).isEmpty && k.due == now + 1 && k.kept == [b: 20])
        allowedOut = []
        check("panes active: keeper: …shown again: nothing sent", step(k, split, focused: 10, front: a).isEmpty && k.due == nil)
        let quitting = k.step(panes: split, focused: 10, front: a, margin: margin, hosted: { _ in true }, allowed: { _ in true }, ending: { $0 == b }, now: now).map(\.description)
        check("panes active: keeper: its app quitting: let go at once", quitting == ["release 502 20"], "\(quitting)")
        _ = step(k, split, focused: 10, front: a)
        k.gone(b)
        check("panes active: keeper: its app quit: forgotten, nothing sent", k.kept.isEmpty && k.touched.isEmpty)
        check("panes active: keeper: …its pane still listed a moment: kept again only if it's still hosted (the engine's allowed)", step(k, split, focused: 10, front: a) == ["keep 502 20"])
        check("panes active: keeper: everything let go at once (Margin quits)", k.releaseAll(why: "quit").map(\.description) == ["release 502 20"] && k.kept.isEmpty && k.touched.isEmpty)
        check("panes active: keeper: Margin's own windows never kept", PanesActive.wanted(panes: [pane(a, 10), pane(margin, 5, x: 310)], focused: 10, front: a, margin: margin, hosted: { _ in true }, allowed: { _ in true }, lastKey: [:]).windows.isEmpty)
    }
    // The loop's guard.
    do {
        let k = PanesActiveKeeper()
        var keeps = 0
        for _ in 0..<70 {
            k.heardFront(b)
            _ = step(k, split, focused: 20, front: b)
            k.heardFront(a)
            keeps += step(k, split, focused: 10, front: a).filter { $0.hasPrefix("keep 502") }.count
            now += 0.01
        }
        check("panes active: keeper: kept again and again (a loop: 70 times in under a second): left alone after \(k.limit) in \(Int(k.limitWindow)) s", k.stopped.contains(b) && keeps == k.limit, "\(keeps)")
    }
    // The cost of a step at rest (four panes): measured.
    do {
        let k = PanesActiveKeeper()
        let four = [pane(a, 10), pane(b, 20, x: 310), pane(c, 30, x: 620), pane(504, 40, x: 930)]
        _ = k.step(panes: four, focused: 10, front: a, margin: margin, hosted: { _ in true }, allowed: { _ in true }, now: now)
        let n = 20_000
        let t0 = Date()
        var sent = 0
        for _ in 0..<n { sent += k.step(panes: four, focused: 10, front: a, margin: margin, hosted: { _ in true }, allowed: { _ in true }, now: now).count }
        let us = Date().timeIntervalSince(t0) / Double(n) * 1e6
        print("  (panes active: a keeper step at rest (four panes, nothing changed) costs \(String(format: "%.2f", us)) µs on the stand-in, \(n) steps; nothing sent)")
        check("panes active: keeper: a step at rest (four panes) sends nothing and costs a few µs (\(String(format: "%.2f", us)) µs)", sent == 0 && us < 50)
    }
}

private func panesActiveEngineTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-panes-active-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let marker = folder.appendingPathComponent(HostMarker.fileName)
    let left = CGRect(x: 276, y: 41, width: 610, height: 933), right = CGRect(x: 894, y: 41, width: 610, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func world(on: Bool = true) -> (FakeHostWorld, HostEngine) {
        let w = FakeHostWorld()
        w.tilesOn = true
        w.panesActive = on
        let e = HostEngine(system: w, marker: marker, pid: 1)
        e.options.privateRetire = 0
        e.options.earlyFullScreen = false
        e.options.activesCoalesced = false
        _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        _ = hostRun { await e.setLayout(main: textEdit, mainRect: left, extras: [HostExtra(target: notes, role: .pane, rect: right)], focused: textEdit.id, in: placement,
                                        marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        return (w, e)
    }
    func scene(_ e: HostEngine, focused: HostID) -> PaneClickScene? {
        guard let t = e.hosts[textEdit.id], let n = e.hosts[notes.id] else { return nil }
        return PaneClickScene(panes: [.init(rect: left, pid: t.pid, window: t.window), .init(rect: right, pid: n.pid, window: n.window)], focused: e.hosts[focused]?.window)
    }

    // ---- off: nothing at all ----
    do {
        let (w, e) = world(on: false)
        e.panesShown(scene(e, focused: textEdit.id))
        e.frontChanged(w.front)
        check("panes active: engine: the part off: nothing sent, nothing kept (only the focused pane draws active, as before)", w.activeCalls.isEmpty && e.keptActive.isEmpty)
    }

    let (w, e) = world()
    guard let te = e.hosts[textEdit.id], let no = e.hosts[notes.id] else { return check("panes active: engine: (a split of TextEdit and Notes)", false) }
    check("panes active: engine: (a split of TextEdit and Notes, TextEdit focused and in front)", e.visible.count == 2 && w.front == te.pid, "\(String(describing: w.front))")
    var told: [Set<pid_t>] = []
    e.onKeptActive = { told.append($0) }
    e.panesShown(scene(e, focused: textEdit.id))
    check("panes active: engine: the split shown: Notes' window kept active (activated, made key), TextEdit's never (the front app)",
          w.activeCalls == ["keep \(no.pid) \(no.window)"] && e.keptActive == [no.pid] && told.last == [no.pid], "\(w.activeCalls)")
    // The cost: every record of a scene that didn't change.
    var mark = w.activeCalls.count
    do {
        let n = 5000
        let t0 = Date()
        for _ in 0..<n { e.stepActives() }
        let us = Date().timeIntervalSince(t0) / Double(n) * 1e6
        print("  (panes active: the engine's step at rest (a split of two, front read, hosts looked up) costs \(String(format: "%.2f", us)) µs on the stand-in, \(n) steps; \(w.activeCalls.count - mark) sent)")
        check("panes active: engine: a step at rest sends nothing and costs a few µs", w.activeCalls.count == mark && us < 100)
    }
    for _ in 0..<50 { e.panesShown(scene(e, focused: textEdit.id)); e.stepActives() }
    var moved = scene(e, focused: textEdit.id)!
    moved.panes[1].rect = right.offsetBy(dx: -40, dy: 0) // (a drag of the divider: the rects every frame)
    e.panesShown(moved)
    check("panes active: engine: at rest (the same scene, a drag's rects): nothing sent", w.activeCalls.count == mark)
    check("panes active: engine: …and the marker has Notes' app kept", HostMarker.read(marker)?.keptActive?.map(\.pid) == [no.pid])

    // A click in Notes' pane: the tap made it the front app; TextEdit's window kept active from then.
    w.front = no.pid
    e.frontChanged(no.pid)
    _ = hostRun { await e.focus(notes.id, fronted: true) }
    e.panesShown(scene(e, focused: notes.id))
    check("panes active: engine: Notes made the front app (the tap): TextEdit's window kept active, nothing sent to Notes (active for real)",
          Array(w.activeCalls.dropFirst(mark)) == ["keep \(te.pid) \(te.window)"] && e.keptActive == [te.pid], "\(w.activeCalls.dropFirst(mark))")
    check("panes active: engine: …the marker lists both apps of the split (from now on unchanged by a click)", Set(HostMarker.read(marker)?.keptActive?.map(\.pid) ?? []) == [te.pid, no.pid])

    // The engine fronting TextEdit (a press the usual way, the sidebar): kept, so the window server makes it the front one.
    mark = w.activeCalls.count
    _ = hostRun { await e.focus(textEdit.id) }
    check("panes active: engine: TextEdit fronted by the engine while kept: the window server makes it the front one first (its own activation may be taken for done)",
          w.activeCalls.dropFirst(mark).first == "makeFront \(te.pid) \(te.window)", "\(w.activeCalls.dropFirst(mark))")
    e.frontChanged(te.pid)
    e.panesShown(scene(e, focused: textEdit.id))
    check("panes active: engine: …then Notes kept again", w.activeCalls.last == "keep \(no.pid) \(no.window)" && e.keptActive == [no.pid], "\(w.activeCalls.dropFirst(mark))")

    // A notification of an app that isn't the window server's front one (a record's activation would be one): not counted.
    mark = w.activeCalls.count
    e.frontChanged(no.pid)
    check("panes active: engine: an activation heard for an app that isn't the window server's front one: nothing sent (no loop)", w.activeCalls.count == mark)

    // Another app in front (not hosted): let go at once; back: kept again.
    w.front = 4321
    e.frontChanged(4321)
    check("panes active: engine: another app in front: Notes let go at once", w.activeCalls.last == "release \(no.pid) \(no.window)" && e.keptActive.isEmpty && told.last == [])
    w.front = te.pid
    e.frontChanged(te.pid)
    check("panes active: engine: …back: kept again", w.activeCalls.last == "keep \(no.pid) \(no.window)" && e.keptActive == [no.pid])

    // The split's scene gone (another Space current, the split ended): after the grace.
    e.actives.grace = 0
    mark = w.activeCalls.count
    e.panesShown(nil)
    check("panes active: engine: no split shown (its grace over): let go", Array(w.activeCalls.dropFirst(mark)) == ["release \(no.pid) \(no.window)"] && e.keptActive.isEmpty, "\(w.activeCalls.dropFirst(mark))")
    check("panes active: engine: …the marker without it", HostMarker.read(marker)?.keptActive == nil)
    e.panesShown(scene(e, focused: textEdit.id))
    check("panes active: engine: the split again: kept again", w.activeCalls.last == "keep \(no.pid) \(no.window)")

    // Its app quits: forgotten, nothing sent.
    mark = w.activeCalls.count
    w.quitNow(no.pid)
    check("panes active: engine: Notes quit: forgotten, nothing sent", w.activeCalls.count == mark && e.keptActive.isEmpty && told.last == [], "\(w.activeCalls.dropFirst(mark))")

    // Margin quits: every kept app let go before the quit's steps, waited for.
    do {
        let (w, e) = world()
        e.panesShown(scene(e, focused: textEdit.id))
        let n = e.hosts[notes.id]!
        _ = hostRun { await e.quitAll() }
        check("panes active: engine: Margin quits: Notes let go at once (sent before the quit goes on)", w.activeCalls == ["keep \(n.pid) \(n.window)", "releaseNow \(n.pid) \(n.window)"] && e.keptActive.isEmpty, "\(w.activeCalls)")
        e.panesShown(scene(e, focused: textEdit.id))
        check("panes active: engine: …nothing kept again once quitting", w.activeCalls.count == 2)
    }

    // A crash: the marker says Notes was kept; the next launch lets go of it if it still says it's active and isn't in front.
    do {
        let (w, e) = world()
        e.panesShown(scene(e, focused: textEdit.id))
        let n = e.hosts[notes.id]!, t = e.hosts[textEdit.id]!
        let m = HostMarker.read(marker)
        check("panes active: engine: crash: the marker lists Notes kept (its pid, window, app and launch)",
              m?.keptActive?.count == 1 && m?.keptActive?.first?.pid == n.pid && m?.keptActive?.first?.window == n.window && m?.keptActive?.first?.bundleId == "com.apple.Notes", "\(String(describing: m?.keptActive))")
        // (The next launch: a new engine on the same world, Margin's old process gone.)
        _ = e
        w.appActiveOf = [n.pid: true]
        let next = HostEngine(system: w, marker: marker, pid: 2)
        next.options.privateRetire = 0
        w.activeCalls = []
        _ = hostRun { await next.recover() }
        check("panes active: engine: crash: the next launch deactivates Notes (it still says it's active, isn't in front)", w.activeCalls.first == "releaseNow \(n.pid) \(n.window)", "\(w.activeCalls)")
        _ = t
    }
    do {
        let (w, e) = world()
        e.panesShown(scene(e, focused: textEdit.id))
        let n = e.hosts[notes.id]!
        w.appActiveOf = [n.pid: false]
        let next = HostEngine(system: w, marker: marker, pid: 2)
        w.activeCalls = []
        _ = hostRun { await next.recover() }
        check("panes active: engine: crash: an app that no longer says it's active (the window server activated and deactivated it since): left alone", !w.activeCalls.contains { $0.hasPrefix("releaseNow") }, "\(w.activeCalls)")
    }
    do {
        let (w, e) = world()
        e.panesShown(scene(e, focused: textEdit.id))
        let n = e.hosts[notes.id]!
        w.appActiveOf = [n.pid: true]
        w.front = n.pid
        let next = HostEngine(system: w, marker: marker, pid: 2)
        w.activeCalls = []
        _ = hostRun { await next.recover() }
        check("panes active: engine: crash: the app in front now: left alone (active for real)", !w.activeCalls.contains { $0.hasPrefix("releaseNow") }, "\(w.activeCalls)")
    }
    do {
        let (w, e) = world()
        e.panesShown(scene(e, focused: textEdit.id))
        let n = e.hosts[notes.id]!
        w.appActiveOf = [n.pid: true]
        let then = w.apps[n.pid]?.launchedAt ?? 0
        w.apps[n.pid]?.launchedAt = then + 100 // (its pid another launch's now)
        let next = HostEngine(system: w, marker: marker, pid: 2)
        w.activeCalls = []
        _ = hostRun { await next.recover() }
        check("panes active: engine: crash: its pid another launch's now: left alone", !w.activeCalls.contains { $0.hasPrefix("releaseNow") }, "\(w.activeCalls)")
    }

    // Coalesced: several changes in one main-queue turn, one step.
    do {
        let (w, e) = world()
        e.options.activesCoalesced = true
        e.panesShown(scene(e, focused: textEdit.id))
        e.frontChanged(w.front)
        e.frontChanged(w.front)
        check("panes active: engine: coalesced: nothing sent within the turn", w.activeCalls.isEmpty)
        _ = hostRun { await Task.yield() }
        check("panes active: engine: coalesced: one step at the turn's end", w.activeCalls.count == 1, "\(w.activeCalls)")
    }
}
