// Peek's card over a split (docs/PEEK-SPLIT.md §2 and §4 together), part of tests.swift's run: the library, the real
// engine on the stand-in world and a stand-in copy. A split of a web page and TextEdit shown whole; a page's click opens
// a card over it: three visible (main, the pane, the card), the split's layout kept, the focused pane still the
// window's item shown. ⌘W with the card focused closes only the card (the split goes on, nothing of it closed); a
// change of the page area places all three again, each at its own rect (the panes at their new <m-pane>s, the card at
// its new <m-peek-page>); a press on the dimmed page closes the card, the split left as it was.
import AppKit
import Foundation

func peekSplitTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("peek-split")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("peek over a split: the library opens (\(scriptPath): npm run build)", false)
    }
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "q\(n)x" } }
    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    session.now = { 1000 }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    session.appName = { $0 == "com.apple.TextEdit" ? "TextEdit" : nil }
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
    // (The page lays out the split of the item in front, as Margin's renderer does.)
    window.splitShown = {
        guard let front = session.requested[1] ?? session.shown[1], let s = library.split(ofItem: front) else { return nil }
        return (s.id, s.panes, s.vertical, [])
    }
    func run(_ body: @escaping () async -> Void) { hostRun { await body(); await session.idle() } }
    let source = LibraryWindowSource(library: library, session: session, profileSource: DataSetWindowSource(data: DataSync(store: DataStore(root: tempFolder("peek-split-profile"))), pick: { nil }))
    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let edit = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""
    links.profiles = ["s-default"]
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://a.example/"]) }
    let a = library.items(space: home).first { $0.value["url"] as? String == "https://a.example/" }?.id ?? ""
    run { _ = library.perform("createSplit", ["windowId": 1, "panes": [a, edit]]) }
    let sp = library.split(ofItem: a)?.id ?? ""
    let safari = HostTarget.safariWindow("s-default").id, editId = HostTarget.app("com.apple.TextEdit").id, cardId = HostTarget.safariWindow("s-default", .card).id
    func bounds(_ id: HostID) -> CGRect? { engine.hosts[id].flatMap { w.bounds(window: $0.window) } }
    func inMargin(_ id: HostID) -> Bool { engine.hosts[id].map { w.spaces(window: $0.window) == [FakeHostWorld.marginSpace] } ?? false }
    func panes() -> [String: CGRect] { Dictionary(uniqueKeysWithValues: (window.paneLayout?.panes ?? []).map { ($0.item, $0.rect) }) }
    let later = { Date().timeIntervalSince1970 * 1000 + 5000 }
    check("peek over a split: set up: a split of a web page and TextEdit shown whole, TextEdit focused",
          session.layout[1]?.split == sp && !sp.isEmpty && engine.visible.count == 2 && session.shown[1] == edit, "\(String(describing: session.layout[1]))")

    // ---- a card over the split: three visible, the split's layout kept ----
    var rects = panes()
    let card = CGRect(x: 400, y: 160, width: 900, height: 650)
    window.cardRect = card
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "ps-1", "url": "https://docs.example.org/", "notAfter": later()]) }
    check("peek over a split: the card over both panes, focused; each pane still at its <m-pane>, the split's layout kept, the focused pane the window's item shown",
          engine.visible.count == 3 && engine.shown == cardId && bounds(cardId) == card && inMargin(cardId) && bounds(safari) == rects[a] && bounds(editId) == rects[edit]
          && inMargin(safari) && inMargin(editId) && session.layout[1]?.split == sp && session.layout[1]?.extras.map(\.role) == [.pane, .card] && session.shown[1] == edit,
          "\(engine.visible) \(String(describing: session.layout[1])) \(String(describing: bounds(cardId)))")

    // ---- ⌘W with the card focused: only the card closes ----
    var out: JSONObject?
    let closesBefore = links.asked.filter { $0.type == "hostClose" }.count
    run { out = source.perform("closeTab", ["windowId": 1]) }
    check("peek over a split: ⌘W with the card focused closes only the card: the split goes on (both panes visible at their rects, its layout, TextEdit focused again), nothing of it closed",
          out?["ok"] as? Bool == true && session.cards.isEmpty && !inMargin(cardId) && engine.visible.count == 2 && session.layout[1]?.split == sp && session.layout[1]?.extras.map(\.role) == [.pane]
          && bounds(safari) == rects[a] && bounds(editId) == rects[edit] && session.shown[1] == edit && engine.shown == editId && library.split(sp)?.panes == [a, edit]
          && links.asked.filter { $0.type == "hostClose" }.count == closesBefore, "\(engine.visible) \(String(describing: session.layout[1])) \(String(describing: engine.shown))")

    // ---- a page-area change with all three visible: each placed again at its own new rect ----
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "ps-2", "url": "https://docs.example.org/two", "notAfter": later()]) }
    check("peek over a split: the card again (its parked window back), three visible", engine.visible.count == 3 && bounds(cardId) == card)
    window.layout = PageLayout(left: 320, top: 8, right: 8, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 1512, height: 949, mode: "fullscreen")
    let card2 = CGRect(x: 440, y: 160, width: 860, height: 650)
    window.cardRect = card2
    run { session.pageRectChanged(window) }
    rects = panes()
    check("peek over a split: the page area changed: all three placed again, the panes at their new <m-pane>s, the card at its new <m-peek-page>, still three visible, the card focused",
          engine.visible.count == 3 && bounds(safari) == rects[a] && bounds(editId) == rects[edit] && bounds(cardId) == card2 && rects[a]?.minX == window.hostedPlacement?.page.minX
          && engine.shown == cardId && session.layout[1]?.split == sp && session.layout[1]?.extras.first { $0.role == .card }?.rect == card2,
          "\(rects) \(String(describing: bounds(safari))) \(String(describing: bounds(editId))) \(String(describing: bounds(cardId))) \(engine.visible)")

    // ---- a press on the dimmed page: the card closes, the split as it was ----
    run { session.caughtPress(window, at: CGPoint(x: 300, y: 100)) }
    check("peek over a split: a press around the card closes it; the split stays shown at its rects",
          session.cards.isEmpty && !inMargin(cardId) && engine.visible.count == 2 && session.layout[1]?.split == sp && bounds(safari) == rects[a] && bounds(editId) == rects[edit],
          "\(engine.visible) \(String(describing: session.layout[1]))")
}
