// The hosted parts joined (HostedSession.swift, ShellHostedGlue.swift), part of tests.swift's run: the library (its
// rules from dist/app/library.js, its files in a temporary folder) and the real host engine on the stand-in window
// manager (host-tests.swift FakeHostWorld), with a stand-in Margin window and stand-in Safari copies. What follows:
// a library request becomes the engine's open or show and the copy's hostShow; two web items of one profile are a
// tab switch only; a palette pick is an item added and opened; Safari picked is a web item, Chrome nothing; closing;
// what the UI draws (open items as the window's tabs, the one shown in front); the page area from the tiles; the
// shell with hosting on: no slot, no opening of the browser, no overlay path.
import AppKit
import Foundation

final class FakeHostedWindow: HostedWindow {
    var pageAreaWhyNot: String { "fake" }
    var fullScreenState: String { "fake" }
    var layoutMode: String? { isFullScreen ? "fullscreen" : "windowed" }
    let id: Int
    let number: Int
    var isFullScreen = false
    var hosting = false
    var pushed: [String] = []
    var hostings: [Bool] = []
    var fullScreenAsks = 0
    var goesFullScreen = true
    // The theme's layout: Arcadia's in full screen, its sidebar 260 pt, the page card 8 pt from the other edges.
    var layout = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 1512, height: 949, mode: "fullscreen")
    init(id: Int, number: Int) { self.id = id; self.number = number }
    func toFullScreen() { fullScreenAsks += 1; if goesFullScreen { isFullScreen = true } }
    func setHosting(_ on: Bool) {
        guard on != hosting else { return }
        hosting = on
        hostings.append(on)
    }
    // (As the real one: from its layout now, while hosting in full screen.)
    var hostedPlacement: HostPlacement? {
        guard hosting, isFullScreen, let page = MarginWindowGeometry.hostedPageRect(display: FakeHostWorld.display, layout: layout, right: 8) else { return nil }
        return HostPlacement(page: page, area: FakeHostWorld.display, tileWidth: MarginWindowGeometry.tileWidth(layout))
    }
    func push(_ json: String) { pushed.append(json) }
    var tiles = 0
    var onTile: ((CGFloat) -> Void)? // the window manager laying its tile out at the new width
    func tile() { tiles += 1; onTile?(MarginWindowGeometry.tileWidth(layout)) }
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
    engine.willTile = { _ in session.willTile() }
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
    check("hosted: Margin's window taken to full screen first, then the sidebar's tile as the app's tile came in", window.fullScreenAsks == 1 && window.isFullScreen && window.hostings == [true] && window.tiles == 1, "\(window.hostings)")
    check("hosted: the engine opened the app (started with no Dock icon) and shows it", w.calls.contains("launch com.apple.TextEdit") && engine.shown == HostTarget.app("com.apple.TextEdit").id, "\(w.calls)")
    let editWindow = w.running(bundleId: "com.apple.TextEdit").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
    check("hosted: the engine was given the page area from the tiles, and its window is there", engine.pageRect == page && w.bounds(window: editWindow) == page, "\(engine.pageRect) \(String(describing: w.bounds(window: editWindow)))")
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
    check("hosted: the app shown before is parked (two tiles in Margin's Space)", engine.hosts[HostTarget.app("com.apple.TextEdit").id]?.phase == .parked && w.tiles[FakeHostWorld.marginSpace]?.count == 2)

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

    // ---- the app's item again: the engine shows it (unparked) ----
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": editItem]) }
    check("hosted: the app's item again: shown by the engine, Safari's window parked (out of full screen by its copy)", engine.shown == HostTarget.app("com.apple.TextEdit").id && engine.hosts[safari]?.phase == .parked
          && links.asked.last { $0.type == "setWindowState" }?.payload["state"] as? String == "normal")

    // ---- Safari and Chrome picked as apps ----
    let before = library.items().count
    run { session.openApp("com.google.Chrome", windowId: 1) }
    check("hosted: Chrome picked: not supported yet, nothing added or launched", library.items().count == before && !w.calls.contains { $0.contains("Chrome") })
    run { session.openApp("com.apple.Safari", windowId: 1) }
    check("hosted: Safari picked: a new web item in Safari (not Safari hosted as an app)", library.items().count == before + 1
          && library.items().contains { $0.value["url"] as? String == "about:blank" } && engine.shown == safari && !w.calls.contains { $0 == "launch com.apple.Safari" && false })

    // ---- the page area moved: the engine told ----
    window.onTile = { w.marginWidth = $0 }
    let tilesBefore = window.tiles
    window.layout.left = 300
    let moved = window.hostedPlacement
    session.pageRectChanged(window)
    session.pageRectChanged(window) // (a burst of layouts: taken once)
    run {}
    let safariNow = w.wins.keys.first { w.wins[$0]?.pid == w.running(bundleId: "com.apple.Safari").first?.pid && w.wins[$0]?.fullScreen == true } ?? 0
    check("hosted: the page area changed (a wider sidebar): Margin's tile given the width alone in its Space, the window placed there", moved?.page.minX == 300 && engine.pageRect == moved?.page
          && window.tiles == tilesBefore + 1 && w.bounds(window: safariNow) == moved?.page, "\(String(describing: moved)) \(engine.pageRect) \(window.tiles - tilesBefore)")

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
    check("hosted: nothing hosted any more: Margin's window its whole width again", window.hostings.last == false && session.hostingWindow == nil && !engine.hasHosts, "\(window.hostings) \(engine.hosts.keys) \(engine.launched) \(w.calls.suffix(8))")
    check("hosted: the Safari window Margin started quit with Safari, nothing left in Margin's Space", w.running(bundleId: "com.apple.Safari").isEmpty && w.tiles[FakeHostWorld.marginSpace]?.count == 1, "\(String(describing: w.tiles[FakeHostWorld.marginSpace]))")

    // ---- Margin's window out of full screen while hosting: the app parked at once, its whole width again ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let wasHosting = session.hostingWindow == 1 && window.hosting
    let editId = HostTarget.app("com.apple.TextEdit").id
    let editNow = w.running(bundleId: "com.apple.TextEdit").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
    session.leavingFullScreen(window)
    window.isFullScreen = false
    w.marginLeavesFullScreen() // (what macOS does with a tile left beside it: alone in a full-screen Space of its own)
    session.leftFullScreen(window)
    hostRun { await engine.parkShown(why: "the test's") } // (after the session's own ask)
    run {}
    check("hosted: Margin's window left full screen while hosting: its whole width again, nothing shown in it", wasHosting && !window.hosting && session.hostingWindow == nil && session.shown[1] == nil)
    check("hosted: … the app parked at once: out of full screen in a private Space, never alone in a full-screen Space of its own", engine.shown == nil && engine.hosts[editId]?.phase == .parked
          && w.wins[editNow]?.fullScreen == false && w.wins[editNow]?.priv != nil && w.ownerlessFullScreenSpaces() == [] && w.tiles.count == 1, "\(w.tiles) \(String(describing: w.wins[editNow]))")
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": library.items().first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""]) }
    check("hosted: the item shown again: Margin's window to full screen again, the app hosted again beside it", window.isFullScreen && window.hosting && engine.shown == editId
          && w.spaces(window: editNow) == [FakeHostWorld.marginSpace] && session.shown[1] != nil, "\(session.done.suffix(4))")
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
    run { await engine.quitAll() }

    // ---- Margin's window that won't go full screen: nothing hosted ----
    window.isFullScreen = false
    window.goesFullScreen = false
    session.options.fullScreenWait = 0.2
    let launches = w.calls.filter { $0.hasPrefix("launch") }.count
    run { session.openApp("com.apple.Notes", windowId: 1) }
    check("hosted: Margin's window not in full screen: nothing opened (hosting needs its own Space)", w.calls.filter { $0.hasPrefix("launch") }.count == launches && !engine.hasHosts)

    hostedShellTests(script: script)
}

// The page area while hosting, from the tiles.
func hostedGeometryTests() {
    let arcadia = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 1512, height: 949, mode: "fullscreen")
    check("hosted: the sidebar's tile as wide as the page's left inset", MarginWindowGeometry.tileWidth(arcadia) == 260)
    check("hosted: a left inset with a fraction: the tile a whole point wider", MarginWindowGeometry.tileWidth(PageLayout(left: 271.5, top: 0, right: 0, bottom: 0, radius: 0, radii: [], width: 900, height: 600, mode: "fullscreen")) == 272)
    let display = CGRect(x: 0, y: 33, width: 1512, height: 949)
    check("hosted: the page area: the display less Margin's tile and the theme's insets",
          MarginWindowGeometry.hostedPageRect(display: display, layout: arcadia, right: 8) == CGRect(x: 260, y: 41, width: 1244, height: 933))
    // In the sidebar's tile the page has no room: its right inset as last measured with room.
    let narrow = PageLayout(left: 260, top: 8, right: 0, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 260, height: 933, mode: "fullscreen")
    check("hosted: measured in the sidebar's tile: no page there (its right inset not the theme's)", !MarginWindowGeometry.hasPage(narrow) && MarginWindowGeometry.hasPage(arcadia))
    check("hosted: the right inset kept from a wide measure, else the top one",
          MarginWindowGeometry.hostedPageRect(display: display, layout: narrow, right: 12)?.maxX == 1500 && MarginWindowGeometry.hostedPageRect(display: display, layout: narrow, right: nil)?.maxX == 1504)
    check("hosted: on a display another display's left: in its coordinates", MarginWindowGeometry.hostedPageRect(display: CGRect(x: -1920, y: 0, width: 1920, height: 1080), layout: arcadia, right: 8)?.minX == -1660)
    check("hosted: a sidebar wider than the display: no page area", MarginWindowGeometry.hostedPageRect(display: CGRect(x: 0, y: 0, width: 200, height: 600), layout: arcadia, right: 8) == nil)
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
    check("hosted shell: the engine's Safari windows are the copies'", shell.host?.requestSafariWindow != nil && shell.host?.closeSafariWindow != nil && shell.host?.safariFullScreen != nil && shell.host?.safariLinked != nil && shell.host?.willTile != nil)
    check("hosted shell: a palette pick goes to the session", shell.openApp != nil)
    shell.startSlots(spaces: FakeSlotSpaces(), reads: nil)
    check("hosted shell: no slot (Margin hosts the browser's window itself)", shell.slots == nil)
    var entered: [EnterResult] = []
    shell.enter { entered.append($0) }
    check("hosted shell: opening Margin never opens the browser to draw over", entered.count == 1 && shell.entering == nil, "\(entered)")
    shell.track()
    check("hosted shell: the window server's read makes no overlay", shell.overlays.isEmpty)
}
