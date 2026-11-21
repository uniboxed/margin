// Several visible hosts, the session's side (HostedSession `setLayout`, docs/PEEK-SPLIT.md §1), part of tests.swift's
// run (called from multi-host-tests.swift): a Margin window's layout of library items on the real engine and the
// stand-in world, each web item's window its profile's in its role (main's for the first, a card's for Peek's), its tab
// shown there by the copy; the restored-window sweep sparing every role's window; a plain show after it: one item again.
import AppKit
import Foundation

func multiHostSessionTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("multi-host")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("multi-host session: the library opens (\(scriptPath): npm run build)", false)
    }
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "m\(n)x" } }
    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
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
    var told: [[HostShownWindow]] = []
    engine.hostedWindows = { told.append($0); session.hostedWindows($0) }
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
    func run(_ body: @escaping () async -> Void) { hostRun { await body(); await session.idle() } }
    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let editItem = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""
    links.profiles = ["s-default"]
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://a.example/"]) }
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://b.example/"]) }
    let aItem = library.items(space: home).first { $0.value["url"] as? String == "https://a.example/" }?.id ?? ""
    let bItem = library.items(space: home).first { $0.value["url"] as? String == "https://b.example/" }?.id ?? ""
    let safari = HostTarget.safariWindow("s-default").id, peek = HostTarget.safariWindow("s-default", .card).id
    let page = CGRect(x: 260, y: 41, width: 1244, height: 933)
    let left = CGRect(x: 260, y: 41, width: 618, height: 933), right = CGRect(x: 886, y: 41, width: 618, height: 933)
    let card = CGRect(x: 360, y: 106, width: 1044, height: 803)
    let editWindow = w.running(bundleId: "com.apple.TextEdit").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
    let mainWindow = engine.hosts[safari]?.window ?? 0
    check("multi-host session: set up: a web item shown in the profile's main window (the copy's 90), TextEdit parked",
          session.shown[1] == bItem && session.safariWindows == [SafariKey("s-default"): 90] && engine.shown == safari && session.layout.isEmpty,
          "\(session.safariWindows) \(String(describing: session.shown[1]))")

    // A split: the web item in the main window as the left pane, TextEdit the right one.
    var mark = links.asked.count
    run { await session.setLayout(window: 1, main: aItem, mainRect: left, extras: [HostedLayout.Extra(item: editItem, role: .pane, rect: right)]) }
    // (Tiles off here: main's member placed again at its pane's rect out of full screen and in, through its copy.)
    check("multi-host session: a split laid out: the web item's tab in the main window first (out of sight), then both shown at their rects",
          links.types(since: mark).filter { $0 != "setWindowState" } == ["hostShow"] && links.asked.dropFirst(mark).first?.type == "hostShow"
          && int(links.asked.dropFirst(mark).first?.payload["windowId"]) == 90 && links.asked.dropFirst(mark).first?.payload["itemId"] as? String == aItem
          && w.bounds(window: mainWindow) == left && w.bounds(window: editWindow) == right && engine.visible.count == 2,
          "\(links.types(since: mark)) \(String(describing: w.bounds(window: mainWindow))) \(String(describing: w.bounds(window: editWindow)))")
    check("multi-host session: …the window's layout kept (main, the pane, the focused one), its item shown main",
          session.layout[1] == HostedLayout(main: aItem, mainRect: left, extras: [HostedLayout.Extra(item: editItem, role: .pane, rect: right)], focused: aItem) && session.shown[1] == aItem
          && session.open[editItem]?.host == HostTarget.app("com.apple.TextEdit").id, "\(String(describing: session.layout[1]))")
    check("multi-host session: …Margin's window told both hosted windows (its holes)", window.hosted == mainWindow && told.last?.map(\.window) == [mainWindow, editWindow], "\(told)")
    let live = session.live(library.snapshot())
    let tabs = ((live["openTabs"] as? JSONObject)?["tabs"] as? JSONObject) ?? [:]
    func tab(_ item: String) -> JSONObject? { tabs[String(session.number(ofItem: item))] as? JSONObject }
    check("multi-host session: what the UI draws: the focused item active, the other visible one marked visible",
          tab(aItem)?["active"] as? Bool == true && tab(editItem)?["visible"] as? Bool == true && tab(editItem)?["active"] as? Bool == false && tab(bItem)?["visible"] == nil, "\(tabs)")

    // Peek's card: the other web item in the profile's card window (asked in the card's role), focused, over main.
    mark = links.asked.count
    run { await session.setLayout(window: 1, main: aItem, extras: [HostedLayout.Extra(item: bItem, role: .card, rect: card)], focused: bItem) }
    let cardWindow = engine.hosts[peek]?.window ?? 0
    check("multi-host session: a card: its window asked of the copy in the card's role (a new window), then its tab in it",
          links.types(since: mark).filter { $0 != "setWindowState" } == ["hostShow", "newWindow", "hostShow"] && session.safariWindows[SafariKey("s-default", .card)] == 91
          && int(links.asked.last?.payload["windowId"]) == 91 && links.asked.last?.payload["itemId"] as? String == bItem, "\(links.types(since: mark)) \(session.safariWindows)")
    check("multi-host session: …the card at its rect, focused, main at the page area again, the pane parked",
          w.bounds(window: cardWindow) == card && w.bounds(window: mainWindow) == page && w.spaces(window: editWindow) == [] && session.shown[1] == bItem && engine.shown == peek
          && session.open[bItem]?.host == peek && session.layout[1]?.extras.map(\.item) == [bItem], "\(String(describing: w.bounds(window: cardWindow))) \(String(describing: session.layout[1]))")

    // Safari restored windows of its last session (Margin started it): every role's window spared.
    links.epochs["s-default"] = "e2"
    links.restored["s-default"] = [90, 91, 7]
    mark = links.asked.count
    session.sweepRestoredSafariWindows()
    run { await Task.yield() }
    let closed = links.asked.dropFirst(mark).filter { $0.type == "closeWindow" }.compactMap { int($0.payload["windowId"]) }
    check("multi-host session: the restored-window sweep closes only what Safari restored, never main's or the card's window", closed == [7], "\(closed)")

    // A pick in the sidebar after it: one item shown again, the layout gone.
    told = []
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": editItem]) }
    check("multi-host session: a plain show after a layout: one item shown, the layout gone, the card parked, Margin's window told one hole again",
          session.shown[1] == editItem && session.layout.isEmpty && engine.visible.count == 1 && w.spaces(window: cardWindow) == [] && w.bounds(window: editWindow) == page && told.last == [],
          "\(session.layout) \(engine.visible) \(told)")
}
