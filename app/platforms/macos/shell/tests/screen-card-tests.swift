// What the real screen found on 2026-11-21 with Peek's card over a split (fix/screen-card), part of tests.swift's run,
// against the stand-in world (host-tests.swift `FakeHostWorld`, its window server's order: `raised`) and the session:
// - the card's FIRST open over a split, the split's main pane focused: the card window in front of every pane's window
//   (the real screen had main's window above the new card window, the card showing main's page in its top half);
// - a pane's first open beside a split shown: the panes in the layout's order, the focused one in front.
import AppKit
import Foundation

func screenCardTests() {
    screenCardOrderTests()
}

private func screenCardOrderTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("screen-card")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("screen card: the library opens (\(scriptPath): npm run build)", false)
    }
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "sc\(n)x" } }
    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    session.now = { 1000 }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    session.appName = { $0 == "com.apple.Notes" ? "Notes" : nil }
    engine.requestSafariWindow = { await session.requestSafariWindow($0) }
    engine.requestRoleWindow = { await session.requestSafariWindow($0, role: $1) }
    engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
    engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.hostedWindow = { session.hosted($0) }
    engine.hostedWindows = { session.hostedWindows($0) }
    engine.onMinimum = { session.minimum($0) }
    engine.loading = { session.loading($0) }
    library.delegate = session
    var copyWindows: [Int: Int] = [:]
    var newUnraisable = false
    links.onNewWindow = { id, _ in
        guard let pid = w.running(bundleId: "com.apple.Safari").first?.pid else { return }
        let n = w.nextWindow
        w.nextWindow += 1
        w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop])
        w.apps[pid]?.windows.append(n)
        // (A window Safari makes is in front of every other: key, as the copy asks it focused. From the split's set-up on,
        // its raise by Accessibility doesn't take: made a moment ago and moved between Spaces by the bridge.)
        w.raised.insert(n, at: 0)
        if newUnraisable { w.unraisable.insert(n) }
        copyWindows[id] = n
    }
    links.onSetWindowState = { id, on in
        guard let n = copyWindows[id], let pid = w.wins[n]?.pid else { return }
        w.applyFullScreen(pid: pid, window: n, on)
    }
    links.onCloseWindow = { id in if let n = copyWindows.removeValue(forKey: id) { w.closeWindow(n) } }
    window.splitShown = {
        guard let front = session.requested[1] ?? session.shown[1], let s = library.split(ofItem: front) else { return nil }
        return (s.id, s.panes, s.vertical, [])
    }
    func run(_ body: @escaping () async -> Void) { hostRun { await body(); await session.idle() } }
    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    run { session.openApp("com.apple.Notes", windowId: 1) }
    let notesItem = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.Notes" }?.id ?? ""
    links.profiles = ["s-default"]
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://a.example/"]) }
    let a = library.items(space: home).first { $0.value["url"] as? String == "https://a.example/" }?.id ?? ""
    run { _ = library.perform("createSplit", ["windowId": 1, "panes": [a, notesItem], "axis": "vertical"]) }
    let sp = library.split(ofItem: a)?.id ?? ""
    // (Main, the split's Safari pane, focused: the repro's.)
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": a]) }
    let safari = HostTarget.safariWindow("s-default").id, notes = HostTarget.app("com.apple.Notes").id, cardId = HostTarget.safariWindow("s-default", .card).id
    func win(_ id: HostID) -> Int { engine.hosts[id]?.window ?? -1 }
    check("screen card: set up: a split of a web page (main) and Notes, main focused, main's window in front of Notes'",
          session.layout[1]?.split == sp && !sp.isEmpty && engine.visible.count == 2 && engine.shown == safari && w.inFront(win(safari), of: win(notes)) == true,
          "\(String(describing: session.layout[1])) \(engine.visible) \(String(describing: engine.shown)) \(w.raised)")

    // ---- the card's first open over the split, main focused ----
    // (The window server's order read as the real one is: front to back, by the raises; a new window's raise fails.)
    w.autoOnScreen = true
    w.byRaise = true
    newUnraisable = true
    let later = { Date().timeIntervalSince1970 * 1000 + 5000 }
    window.cardRect = CGRect(x: 400, y: 160, width: 900, height: 650)
    var mark = w.calls.count
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "sc-1", "url": "https://docs.example.org/", "notAfter": later()]) }
    func activations() -> [String] { w.calls.dropFirst(mark).filter { $0.hasPrefix("activate") } }
    check("screen card: the card's FIRST open over a split, main focused: the card window in front of both panes' windows (main never raised over it), the card focused",
          engine.visible.count == 3 && engine.shown == cardId && w.inFront(win(cardId), of: win(safari)) == true && w.inFront(win(cardId), of: win(notes)) == true
          && !activations().contains { $0.hasSuffix(" \(win(safari))") },
          "card \(win(cardId)) notes \(win(notes)) main \(win(safari)); front to back \(w.raised); \(activations())")
    check("screen card: …and its app made active last (the card has the keys)", activations().last?.hasSuffix(" \(win(cardId))") == true, "\(activations())")

    // ---- a press on the dimmed page closes it; then a pane's first open beside the split, focused ----
    run { session.caughtPress(window, at: CGPoint(x: 300, y: 100)) }
    check("screen card: (the card closed: the split again, main focused, in front)",
          session.cards.isEmpty && engine.visible.count == 2 && engine.shown == safari && w.inFront(win(safari), of: win(notes)) == true, "\(engine.visible) \(w.raised)")
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://b.example/"]) }
    let b = library.items(space: home).first { $0.value["url"] as? String == "https://b.example/" }?.id ?? ""
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": a]) }
    mark = w.calls.count
    run { _ = library.perform("addToSplit", ["windowId": 1, "tabId": b, "splitId": sp]) }
    let pane1 = HostTarget.safariWindow("s-default", .pane(1)).id
    check("screen card: a pane's first open beside the split shown, focused: its new window in front of the other panes' (none raised over it), its app made active last",
          engine.visible.count == 3 && engine.shown == pane1 && w.inFront(win(pane1), of: win(safari)) == true && w.inFront(win(pane1), of: win(notes)) == true
          && activations().last?.hasSuffix(" \(win(pane1))") == true,
          "pane \(win(pane1)) notes \(win(notes)) main \(win(safari)); front to back \(w.raised); \(activations()) \(engine.visible)")
}
