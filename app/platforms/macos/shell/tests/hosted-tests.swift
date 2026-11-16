// The hosted parts joined (HostedSession.swift, ShellHostedGlue.swift), part of tests.swift's run: the library (its
// rules from dist/app/library.js, its files in a temporary folder) and the real host engine on the stand-in window
// manager (host-tests.swift FakeHostWorld), with a stand-in Margin window and stand-in Safari copies. What follows:
// a library request becomes the engine's open or show and the copy's hostShow; two web items of one profile are a
// tab switch only; a palette pick is an item added and opened; Safari picked is a web item, Chrome nothing; closing;
// what the UI draws (open items as the window's tabs, the one shown in front); the page area from Margin's own layout,
// the loading animation, Margin's window back into full screen with what it showed; the
// shell with hosting on: no slot, no opening of the browser, no overlay path.
import AppKit
import Foundation

final class FakeHostedWindow: HostedWindow {
    var pageAreaWhyNot: String { "fake" }
    var fullScreenState: String { "fake" }
    var layoutMode: String? { isFullScreen ? "fullscreen" : "windowed" }
    let id: Int
    let number: Int
    var isFullScreen = true // (always, while hosting is on)
    var hosting = false
    var pushed: [String] = []
    var hostings: [Bool] = []
    var fullScreenAsks = 0
    var goesFullScreen = true
    // The theme's layout at the window's whole width: Arcadia's in full screen, its sidebar 260 pt, the page card 8 pt from the other edges.
    var layout = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 1512, height: 949, mode: "fullscreen")
    init(id: Int, number: Int) { self.id = id; self.number = number }
    func toFullScreen() { fullScreenAsks += 1; if goesFullScreen { isFullScreen = true } }
    func setHosting(_ on: Bool) {
        guard on != hosting else { return }
        hosting = on
        hostings.append(on)
        if !on { below = nil; loading = nil }
    }
    var below: Int?
    var belows: [Int?] = [] // each keepBelow, in order
    func keepBelow(_ number: Int?) { guard number != below else { return }; below = number; belows.append(number) }
    var loading: String?
    var loadings: [String?] = [] // each setLoading, in order
    func setLoading(_ label: String?) { guard label != loading else { return }; loading = label; loadings.append(label) }
    var remeasures = 0
    func remeasure() { remeasures += 1 }
    // (As the real one: the page area from its own layout, while hosting in full screen.)
    var hostedPlacement: HostPlacement? {
        guard hosting, isFullScreen, let page = MarginWindowGeometry.pageRect(layout: layout, content: FakeHostWorld.display) else { return nil }
        return HostPlacement(page: page, area: FakeHostWorld.display)
    }
    func push(_ json: String) { pushed.append(json) }
}

final class FakeHostedLinks: HostedLinks {
    var profiles: [String] = []
    var asked: [(profile: String, type: String, payload: JSONObject)] = []
    var nextWindow = 90, nextTab = 500
    var onNewWindow: ((Int) -> Void)? // the copy's id for the window it makes
    var onSetWindowState: ((Int, Bool) -> Void)? // the copy's id, full screen or not
    var onCloseWindow: ((Int) -> Void)?
    var refuse: Set<String> = []
    func safariProfiles() -> [String] { profiles }
    var menuOpens: [String] = [] // profiles woken through Safari's menu
    var wakes: Set<String> = [] // profiles that link when woken
    var windowsOf: [String: [Int]] = [:]
    func openProfileWindow(_ profile: String) -> Bool {
        menuOpens.append(profile)
        if wakes.contains(profile) { profiles.append(profile); windowsOf[profile, default: []].append(77) }
        return true
    }
    func windowIds(of profile: String) -> [Int] { windowsOf[profile] ?? [] }
    var restored: [String: [Int]] = [:]
    var epochs: [String: String] = [:]
    func restoredWindowIds(of profile: String) -> [Int]? { profiles.contains(profile) ? (restored[profile] ?? []) : nil }
    func linkEpoch(of profile: String) -> String? { profiles.contains(profile) ? (epochs[profile] ?? "e1") : nil }
    func request(profile: String, _ type: String, _ payload: JSONObject) async -> (result: JSONObject?, error: String?) {
        asked.append((profile, type, payload))
        guard profiles.contains(profile) else { return (nil, "not linked") }
        if refuse.contains(type) { return (nil, "refused") }
        switch type {
        case "newWindow":
            onNewWindow?(nextWindow)
            nextWindow += 1
            return (["windowId": nextWindow - 1, "state": "normal"], nil)
        case "setWindowState":
            guard let id = int(payload["windowId"]) else { return (nil, "no window") }
            onSetWindowState?(id, payload["state"] as? String == "fullscreen")
            return (["windowId": id, "state": payload["state"] ?? "", "landedAt": 1], nil)
        case "closeWindow":
            if let id = int(payload["windowId"]) { onCloseWindow?(id) }
            return ([:], nil)
        case "hostShow":
            nextTab += 1
            return (["tabId": nextTab - 1, "created": true], nil)
        default:
            return ([:], nil)
        }
    }
    func types(since: Int = 0) -> [String] { asked.dropFirst(since).map(\.type) }
}

// An engine that only says which app Margin started (the restored-window sweep's one question).
final class StubLaunchEngine: HostedEngine {
    var safariPid: pid_t?
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult { .failed(.margin, "stub") }
    func show(_ id: HostID) async -> HostResult { .failed(.margin, "stub") }
    func close(_ id: HostID) async {}
    func pageRectChanged(_ placement: HostPlacement) async -> Bool { false }
    func parkShown(why: String) async {}
    var shown: HostID? { nil }
    var hasHosts: Bool { false }
    func isHosted(_ id: HostID) -> Bool { false }
    func mode(of id: HostID) -> HostMode? { nil }
    var shownAbove: Int? { nil }
    func activateShown(at point: CGPoint?) async {}
    func fullScreenSpace(ofWindow number: Int) -> UInt64? { nil }
    func target(ofWindow number: Int) -> HostTarget? { nil }
    func launchedPid(bundleId: String) -> pid_t? { bundleId == safariIdentifier ? safariPid : nil }
}

func restoredSweepTests(_ library: Library) {
    let stub = StubLaunchEngine()
    let links = FakeHostedLinks()
    links.profiles = ["s-default", "s-work"]
    links.restored = ["s-default": [5, 6], "s-work": [9]]
    let s = HostedSession(library: library, engine: stub, links: links)
    s.sleep = { _ in await Task.yield() }
    func closes() -> [String] { links.asked.filter { $0.type == "closeWindow" }.map { "\($0.profile):\(int($0.payload["windowId"]) ?? -1)" }.sorted() }
    s.sweepRestoredSafariWindows()
    hostRun { await Task.yield() }
    check("hosted sweep: a Safari the person opened (not started by Margin): none of its windows closed", closes().isEmpty)
    stub.safariPid = 4242
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: Safari started by Margin: every restored window of each linked profile closed by its copy", closes() == ["s-default:5", "s-default:6", "s-work:9"], "\(closes())")
    links.asked = []
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: once per link (the next poll closes nothing again)", closes().isEmpty, "\(closes())")
    links.epochs["s-work"] = "e2"
    links.restored["s-work"] = [11]
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: a profile linked again (Safari reopened it): swept again", closes() == ["s-work:11"], "\(closes())")
    links.asked = []
    s.options.closesRestoredSafariWindows = false
    links.epochs["s-default"] = "e3"
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: off: nothing closed", closes().isEmpty)
}

func hostedTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    hostedGeometryTests()
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let script = URL(fileURLWithPath: scriptPath)
    let dataRoot = tempFolder("hosted")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: script, background: false) else { return check("hosted: the library opens (\(scriptPath): npm run build)", false) }
    restoredSweepTests(library)
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "h\(n)x" } }

    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    session.appName = { $0 == "com.apple.TextEdit" ? "TextEdit" : nil }
    engine.requestSafariWindow = { await session.requestSafariWindow($0) }
    engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
    engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.loading = { session.loading($0) }
    engine.keepAbove = { session.keepBelow($0) }
    library.delegate = session
    var changes = 0
    session.onChange = { changes += 1 }
    // A Safari Margin starts links its copy (the default profile's), and the copy's newWindow makes a window, on the
    // Desktop: Accessibility doesn't see it there while Margin's Space is current; its copy's setWindowState and
    // closeWindow act on it.
    var copyWindows: [Int: Int] = [:]
    links.onNewWindow = { id in
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
    let page = CGRect(x: 260, y: 41, width: 1244, height: 933)
    func run(_ body: @escaping () async -> Void) { hostRun { await body(); await session.idle() } }

    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""

    // ---- a palette pick: an item added, its app opened in the page area ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let textEdit = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.TextEdit" }
    let editItem = textEdit?.id ?? ""
    check("hosted: a palette pick: an item of the window's space, its app's name from the catalog",
          textEdit != nil && library.target(ofItem: editItem) == .app(bundleId: "com.apple.TextEdit", name: "TextEdit"), "\(library.items())")
    check("hosted: Margin's window already full screen (it always is): never asked, hosting above its own layout", window.fullScreenAsks == 0 && window.isFullScreen && window.hostings == [true], "\(window.hostings)")
    check("hosted: the engine opened the app (started with no Dock icon) and shows it", w.calls.contains("launch com.apple.TextEdit") && engine.shown == HostTarget.app("com.apple.TextEdit").id, "\(w.calls)")
    let editWindow = w.running(bundleId: "com.apple.TextEdit").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
    check("hosted: the engine was given the page area from Margin's own layout, and its window is there, a member of Margin's Space", engine.pageRect == page && w.bounds(window: editWindow) == page
          && w.wins[editWindow]?.member == true && w.listsMarginOnly, "\(engine.pageRect) \(String(describing: w.bounds(window: editWindow)))")
    check("hosted: the loading animation named the app while it opened, then went", window.loadings == ["TextEdit", nil], "\(window.loadings)")
    check("hosted: Margin's window kept below the app's window", window.below == editWindow, "\(window.belows)")
    check("hosted: it's the window's item shown, open", session.shown[1] == editItem && session.open[editItem]?.host == HostTarget.app("com.apple.TextEdit").id && changes > 0)

    // ---- the same app picked again: its item, no second launch ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    check("hosted: picked again: the item it has, nothing launched twice", library.items(space: home).filter { $0.value["url"] as? String == "app://com.apple.TextEdit" }.count == 1
          && w.calls.filter { $0 == "launch com.apple.TextEdit" }.count == 1)

    // ---- a typed address (newTab): a web item, Safari started with no Dock icon, its copy's window, the tab ----
    links.profiles = ["s-default"] // (its copy links as Safari starts)
    let mark = links.asked.count
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://a.example/"]) }
    let aItem = library.items(space: home).first { $0.value["url"] as? String == "https://a.example/" }?.id ?? ""
    let safari = HostTarget.safariWindow("s-default").id
    check("hosted: newTab: Safari started with no Dock icon, its window shown", w.calls.contains("launch com.apple.Safari") && engine.shown == safari, "\(w.calls.suffix(5))")
    check("hosted: the window asked of the default profile's copy, put in full screen by it, then the item's tab in it", links.types(since: mark) == ["newWindow", "setWindowState", "hostShow"] && links.asked.last?.profile == "s-default", "\(links.types(since: mark))")
    let state = links.asked.first { $0.type == "setWindowState" }?.payload ?? [:]
    let safariWindow = copyWindows[90] ?? 0
    check("hosted: setWindowState names the copy's window, full screen, focused, with a notAfter", int(state["windowId"]) == 90 && state["state"] as? String == "fullscreen" && state["focused"] as? Bool == true
          && (num(state["notAfter"]) ?? 0) > Date().timeIntervalSince1970 * 1000, "\(state)")
    check("hosted: Safari's window never put in full screen through Accessibility", !w.calls.contains("fullScreen true \(safariWindow)") && w.wins[safariWindow]?.fullScreen == true)
    let show = links.asked.last?.payload ?? [:]
    check("hosted: hostShow names the hosted window, the item and its address", int(show["windowId"]) == 90 && show["itemId"] as? String == aItem && show["url"] as? String == "https://a.example/", "\(show)")
    check("hosted: the app shown before is parked (still full screen), Safari's window alone in Margin's Space", engine.hosts[HostTarget.app("com.apple.TextEdit").id]?.phase == .parked
          && w.wins[editWindow]?.fullScreen == true && w.inMargin == [safariWindow] && window.loadings.suffix(2) == ["Safari", nil], "\(w.inMargin) \(window.loadings)")

    // ---- a second web item of the same profile: a tab switch only ----
    let calls = w.calls.count
    let mark2 = links.asked.count
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://b.example/"]) }
    let bItem = library.items(space: home).first { $0.value["url"] as? String == "https://b.example/" }?.id ?? ""
    check("hosted: a second web item of that profile: its tab only, the engine not asked", links.types(since: mark2) == ["hostShow"] && w.calls.count == calls && session.shown[1] == bItem, "\(links.types(since: mark2)) \(w.calls.dropFirst(calls))")
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": aItem]) }
    check("hosted: back to the first: a tab switch again", links.types(since: mark2) == ["hostShow", "hostShow"] && w.calls.count == calls && session.shown[1] == aItem)

    // ---- what the UI draws ----
    let snap = session.live(library.snapshot())
    let open = snap["openTabs"] as? JSONObject ?? [:]
    let tabs = (open["tabs"] as? JSONObject ?? [:]).values.compactMap { $0 as? JSONObject }
    let kept = open["keptTabs"] as? JSONObject ?? [:]
    let front = tabs.first { $0["active"] as? Bool == true }
    check("hosted: the open items are the window's tabs, the one shown in front, the others kept",
          tabs.count == 3 && front?["mid"] as? String == aItem && int(front?["windowId"]) == 1 && kept[aItem] == nil && kept[editItem] == nil, "\(tabs) \(kept.keys)")
    let source = LibraryWindowSource(library: library, session: session, profileSource: DataSetWindowSource(data: DataSync(store: DataStore(root: tempFolder("hosted-profile"))), pick: { nil }))
    let bNumber = session.number(ofItem: bItem)
    let mark3 = links.asked.count
    run { _ = source.perform("activateTab", ["windowId": 1, "tabId": bNumber, "hint": ["url": "https://b.example/"]]) }
    check("hosted: a press on an open item's row (its number): that item shown", session.shown[1] == bItem && links.types(since: mark3) == ["hostShow"])
    let searched = source.perform("search", ["windowId": 1, "query": "margin app"])
    check("hosted: a search typed in the palette: a web item at the engine's address", searched?["ok"] as? Bool == true
          && library.items(space: home).contains { ($0.value["url"] as? String)?.hasPrefix("https://www.google.com/search?") == true && ($0.value["url"] as? String)?.contains("q=margin%20app") == true })
    run {}
    let unsupported = source.perform("openLauncher", ["windowId": 1])
    check("hosted: a request the library doesn't take: refused, said to the page", unsupported?["ok"] as? Bool == false)
    check("hosted: the UI's own bookkeeping requests: answered quietly", source.perform("sidebarScroll", ["windowId": 1])?["ok"] as? Bool == true)

    // ---- the app's item again: an instant switch ----
    let setStates = links.types().filter { $0 == "setWindowState" }.count
    let loadingsBefore = window.loadings.count
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": editItem]) }
    check("hosted: the app's item again: shown by the engine at once (no loading), Safari's window parked as it is (its copy not asked)",
          engine.shown == HostTarget.app("com.apple.TextEdit").id && engine.hosts[safari]?.phase == .parked && w.wins[safariWindow]?.fullScreen == true
          && links.types().filter { $0 == "setWindowState" }.count == setStates && window.loadings.count == loadingsBefore && window.below == editWindow, "\(window.loadings)")

    // ---- Safari and Chrome picked as apps ----
    let before = library.items().count
    run { session.openApp("com.google.Chrome", windowId: 1) }
    check("hosted: Chrome picked: not supported yet, nothing added or launched", library.items().count == before && !w.calls.contains { $0.contains("Chrome") })
    run { session.openApp("com.apple.Safari", windowId: 1) }
    check("hosted: Safari picked: a new web item in Safari (not Safari hosted as an app)", library.items().count == before + 1
          && library.items().contains { $0.value["url"] as? String == "about:blank" } && engine.shown == safari)

    // ---- the page area moved (another theme): the one shown placed again, with the loading animation ----
    window.layout.left = 300
    let moved = window.hostedPlacement
    let loadingsNow = window.loadings.count
    session.pageRectChanged(window)
    session.pageRectChanged(window) // (a burst of layouts: taken once)
    run {}
    check("hosted: the page area changed: the engine told, Safari's window placed there again, the loading animation meanwhile", moved?.page.minX == 300 && engine.pageRect == moved?.page
          && w.bounds(window: safariWindow) == moved?.page && Array(window.loadings.dropFirst(loadingsNow)) == ["Safari", nil] && w.listsMarginOnly,
          "\(String(describing: moved)) \(engine.pageRect) \(window.loadings)")

    // ---- closing ----
    let mark4 = links.asked.count
    run { _ = library.perform("closeTab", ["windowId": 1, "tabId": aItem]) }
    check("hosted: a web item closed: its tab closed by its copy, archived", links.types(since: mark4).first == "hostClose" && session.open[aItem] == nil
          && library.items().allSatisfy { $0.id != aItem } && (library.values["archive"] as? JSONObject ?? [:]).count >= 1, "\(links.types(since: mark4))")
    run { _ = library.perform("closeTab", ["windowId": 1, "tabId": editItem]) }
    check("hosted: an app item closed: the engine closes its app (quit, Margin started it)", !engine.isHosted(HostTarget.app("com.apple.TextEdit").id) && w.running(bundleId: "com.apple.TextEdit").isEmpty)
    for item in library.items().map(\.id) where session.open[item] != nil { run { _ = library.perform("closeTab", ["windowId": 1, "tabId": item]) } }
    let closeMark = links.asked.count
    run { await engine.close(safari) }
    session.hostEvent(.closed(safari))
    check("hosted: Safari's window closed by its copy before the Safari Margin started is quit", links.types(since: closeMark).contains("closeWindow") && w.wins[safariWindow] == nil && engine.leftSafariWindows.isEmpty, "\(links.types(since: closeMark))")
    run {}
    check("hosted: nothing hosted any more: Margin's window its launcher again", window.hostings.last == false && session.hostingWindow == nil && !engine.hasHosts, "\(window.hostings) \(engine.hosts.keys) \(engine.launched) \(w.calls.suffix(8))")
    check("hosted: the Safari window Margin started quit with Safari, nothing left in Margin's Space", w.running(bundleId: "com.apple.Safari").isEmpty && w.inMargin.isEmpty && w.listsMarginOnly, "\(w.inMargin)")

    // ---- macOS took Margin's window out of full screen while hosting: the app parked at once, back with Margin ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let wasHosting = session.hostingWindow == 1 && window.hosting
    let editId = HostTarget.app("com.apple.TextEdit").id
    let editNow = w.running(bundleId: "com.apple.TextEdit").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
    let editItemNow = session.shown[1]
    session.leavingFullScreen(window)
    window.isFullScreen = false
    w.marginLeavesFullScreen() // (macOS: Margin's window on the Desktop, its Space left with the member in it)
    session.leftFullScreen(window)
    hostRun { await engine.parkShown(why: "the test's") } // (after the session's own ask)
    run {}
    check("hosted: Margin's window out of full screen while hosting: nothing shown in it, the item kept to show again", wasHosting && !window.hosting && session.hostingWindow == nil
          && session.shown[1] == nil && session.resume[1] == editItemNow && editItemNow != nil)
    check("hosted: … the app parked at once, still full screen, in a private Space; Margin's old Space destroyed", engine.shown == nil && engine.hosts[editId]?.phase == .parked
          && w.wins[editNow]?.fullScreen == true && w.wins[editNow]?.priv != nil && w.tiles[FakeHostWorld.marginSpace] == nil && w.destroyedWithWindows == 0, "\(w.tiles) \(String(describing: w.wins[editNow]))")
    // Margin's window goes straight back into full screen (MarginWindowController), and the session hosts it again.
    window.isFullScreen = true
    w.marginEntersFullScreen()
    session.enteredFullScreen(window)
    run {}
    check("hosted: Margin's window back in full screen: the item it showed hosted again, in its Space, at once",
          window.hosting && engine.shown == editId && w.spaces(window: editNow) == [FakeHostWorld.marginSpace] && session.shown[1] == editItemNow && session.resume.isEmpty
          && window.below == editNow && w.listsMarginOnly, "\(session.done.suffix(4))")
    // ---- a profile with no window: woken through Safari's menu, its waking window closed after Margin's is made ----
    do {
        let woken = FakeHostedLinks()
        woken.wakes = ["s-quiet"]
        let s2 = HostedSession(library: library, engine: engine, links: woken)
        s2.sleep = { _ in await Task.yield() }
        var linked = false
        var made: HostSafariWindow?
        hostRun { linked = await s2.safariLinked("s-quiet"); made = await s2.requestSafariWindow("s-quiet") }
        check("hosted: a profile with no window is woken once through Safari's menu", woken.menuOpens == ["s-quiet"], "\(woken.menuOpens)")
        check("hosted: then linked, its window made, the waking window closed", linked && made != nil && woken.asked.map(\.type) == ["newWindow", "closeWindow"]
              && int(woken.asked.last?.payload["windowId"]) == 77, "\(woken.asked.map(\.type))")
        let none = FakeHostedLinks()
        let s3 = HostedSession(library: library, engine: engine, links: none)
        s3.sleep = { _ in await Task.yield() }
        s3.options.linkWait = 0.05
        var never = true
        hostRun { never = await s3.safariLinked("s-gone") }
        check("hosted: a profile that never links: asked through the menu twice, then given up", !never && none.menuOpens == ["s-gone", "s-gone"] && none.asked.isEmpty, "\(none.menuOpens)")
    }
    // ---- an app that can't go full screen (window mode): above Margin's own layout, kept below its window ----
    do {
        let ftId = HostTarget.app("com.apple.FaceTime").id, editId = HostTarget.app("com.apple.TextEdit").id
        run { session.openApp("com.apple.FaceTime", windowId: 1) }
        let ftItem = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.FaceTime" }?.id ?? ""
        let ftPid = w.running(bundleId: "com.apple.FaceTime").first?.pid ?? 0
        let ftWindow = w.apps[ftPid]?.windows.first ?? 0
        check("hosted window mode: FaceTime picked: shown in window mode, its window at Margin's own page area", engine.shown == ftId && engine.mode(of: ftId) == .window
              && w.bounds(window: ftWindow) == window.hostedPlacement?.page && session.shown[1] == ftItem, "\(session.done.suffix(4))")
        check("hosted window mode: Margin's window kept right below FaceTime's window; TextEdit parked", window.below == ftWindow && engine.hosts[editId]?.phase == .parked, "\(window.belows)")
        session.pagePressed(window)
        hostRun { for _ in 0..<5 { await Task.yield() } }
        check("hosted window mode: a press in the page area around it: FaceTime given the keyboard (activated, raised)", w.calls.contains("activate \(ftPid) \(ftWindow)"), "\(w.calls.suffix(3))")

        // to the full-screen app, and back: both instant
        let editNowItem = library.items().first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""
        run { _ = library.perform("activateTab", ["windowId": 1, "tabId": editNowItem]) }
        check("hosted window mode → full screen: TextEdit back in Margin's Space, Margin's window kept below it", engine.shown == editId && window.below == editNow && engine.hosts[ftId]?.phase == .parked, "\(window.belows) \(session.done.suffix(4))")
        run { _ = library.perform("activateTab", ["windowId": 1, "tabId": ftItem]) }
        check("hosted full screen → window mode: FaceTime shown again, Margin's window kept below it", engine.shown == ftId && window.below == ftWindow
              && w.bounds(window: ftWindow) == window.hostedPlacement?.page && w.inMargin == [ftWindow], "\(session.done.suffix(4))")

        // the page area moves (another theme): placed again by Accessibility, not parked
        let moves = w.calls.filter { $0.hasPrefix("move \(ftWindow) ") }.count
        window.layout.left = 240
        session.pageRectChanged(window)
        run {}
        check("hosted window mode: the page area moved: FaceTime placed there again, never parked for it", w.bounds(window: ftWindow) == window.hostedPlacement?.page && window.hostedPlacement?.page.minX == 240
              && w.calls.filter { $0.hasPrefix("move \(ftWindow) ") }.count == moves, "\(String(describing: w.bounds(window: ftWindow)))")

        // closed: its frame back, then quit
        run { _ = library.perform("closeTab", ["windowId": 1, "tabId": ftItem]) }
        check("hosted window mode: FaceTime's item closed: its frame given back before it was quit", w.frameAtQuit["com.apple.FaceTime"] == FakeHostWorld.defaultFrame && w.running(bundleId: "com.apple.FaceTime").isEmpty
              && w.saved["com.apple.FaceTime"] == FakeHostWorld.defaultFrame, "\(String(describing: w.frameAtQuit))")
        window.layout.left = 300
    }
    run { await engine.quitAll() }

    // ---- Margin's window found windowed anyway (it never should be): asked once more; it won't: nothing hosted ----
    window.isFullScreen = false
    window.goesFullScreen = false
    session.options.fullScreenWait = 0.2
    let launches = w.calls.filter { $0.hasPrefix("launch") }.count
    let asks = window.fullScreenAsks
    run { session.openApp("com.apple.Notes", windowId: 1) }
    check("hosted: Margin's window not in full screen (a safety check): asked once, it didn't go: nothing opened", w.calls.filter { $0.hasPrefix("launch") }.count == launches && !engine.hasHosts
          && window.fullScreenAsks == asks + 1 && session.done.contains { $0.contains("it always is while hosting is on") })
    window.goesFullScreen = true
    window.isFullScreen = true

    hostedShellTests(script: script)
}

// The page area while hosting: Margin's own layout at its whole width (the theme's frame around it).
func hostedGeometryTests() {
    let arcadia = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 1512, height: 949, mode: "fullscreen")
    let display = CGRect(x: 0, y: 33, width: 1512, height: 949)
    check("hosted: the page area: Margin's whole window less the theme's insets", MarginWindowGeometry.pageRect(layout: arcadia, content: display) == CGRect(x: 260, y: 41, width: 1244, height: 933))
    check("hosted: a layout measured at another size: no page area until the page measures again", MarginWindowGeometry.pageRect(layout: arcadia, content: CGRect(x: 0, y: 33, width: 1200, height: 800)) == nil)
    check("hosted: that page area as its own Space's reservation", HostLayout.plan(HostPlacement(page: CGRect(x: 260, y: 41, width: 1244, height: 933), area: display)) == SlotEdges(left: 260, right: 8, top: 8, bottom: 8))
    check("hosted: a search's address: the engine Safari uses, as learned, else Google's", LibraryWindowSource.searchUrl("a b&c", settings: nil).hasPrefix("https://www.google.com/search?client=safari")
          && LibraryWindowSource.searchUrl("a b&c", settings: nil).contains("q=a%20b%26c")
          && LibraryWindowSource.searchUrl("x", settings: ["safariSearch": ["template": "https://duckduckgo.com/?q=%s"]]) == "https://duckduckgo.com/?q=x"
          && LibraryWindowSource.searchUrl("x", settings: ["safariSearch": ["template": "javascript:%s"]]).hasPrefix("https://www.google.com/"))
}

// The shell with hosting on: the library is the windows' source, the first run's space, no slot, no opening of the browser.
func hostedShellTests(script: URL) {
    let root = tempFolder("hosted-shell")
    defer { try? FileManager.default.removeItem(at: root) }
    var options = Shell.Options()
    options.harness = true
    options.overlay.harness = true
    options.root = script.deletingLastPathComponent()
    options.dataRoot = root
    options.hosted = true
    options.slot = true
    options.enter = true
    let w = FakeHostWorld()
    options.hostSystem = w
    let shell = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
    defer { shell.stop {} }
    check("hosted shell: the host engine made on the harness's system", shell.host != nil && shell.library != nil)
    let source = shell.makeHostedSource()
    check("hosted shell: Margin's windows draw the library", source is LibraryWindowSource && shell.hosted != nil && shell.library?.delegate === shell.hosted)
    check("hosted shell: the first run with nothing to import: one space made, for the person to name in the editor",
          shell.library?.spaces().count == 1 && shell.hosted?.firstSpace == shell.library?.spaces().first?.id)
    check("hosted shell: the engine's Safari windows are the copies'", shell.host?.requestSafariWindow != nil && shell.host?.closeSafariWindow != nil && shell.host?.safariFullScreen != nil && shell.host?.safariLinked != nil && shell.host?.loading != nil)
    check("hosted shell: Margin's window kept below the hosted window", shell.host?.keepAbove != nil)
    check("hosted shell: a palette pick goes to the session", shell.openApp != nil)
    shell.startSlots(spaces: FakeSlotSpaces(), reads: nil)
    check("hosted shell: no slot (Margin hosts the browser's window itself)", shell.slots == nil)
    var entered: [EnterResult] = []
    shell.enter { entered.append($0) }
    check("hosted shell: opening Margin never opens the browser to draw over", entered.count == 1 && shell.entering == nil, "\(entered)")
    shell.track()
    check("hosted shell: the window server's read makes no overlay", shell.overlays.isEmpty)
}
