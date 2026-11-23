// The session's rules that step 3 of docs/CORE-REFACTOR.md moves into margin-core, pinned against the Swift before
// they move (part of tests.swift's run): the four pin and favourite paths of the library's requests (open and reset,
// each with an item or not, `addItem` refused, overtaken), which panes leave a split without room at the edges of
// its slack, the last item's tie, a web address, a search's address, the UI pushes' caps, a host's logged form, the
// ground's holes with zero-size and touching rects, the pointer through several holes, the page's layout report.
import AppKit
import Foundation

func sessionRulesTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    libraryPinRequestTests()
    noRoomEdgeTests()
    lastItemTests()
    webAddressTests()
    searchUrlTests()
    uiPushCapTests()
    hostIdLogTests()
    groundHoleTests()
    passThroughHoleTests()
    pageLayoutReportTests()
}

// ---- the library's pin and favourite requests (HostedSession.handle: openPin, resetPin, openFavorite, resetFavorite) ----

private func libraryPinRequestTests() {
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("pin-requests")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("pin requests: the library opens (\(scriptPath): npm run build)", false)
    }
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "q\(n)x" } }
    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    session.options.preparesBrowser = false
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    engine.requestSafariWindow = { await session.requestSafariWindow($0) }
    engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
    engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.loading = { session.loading($0) }
    engine.hostedWindow = { session.hosted($0) }
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
    func run(_ body: @escaping () async -> Void = {}) { hostRun { await body(); await session.idle() } }
    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    links.profiles = ["s-default"]
    let web = ItemTarget.web(browser: "safari", profile: nil)
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://a.example/"]) }
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://b.example/"]) }
    let item = { (url: String) in library.items(space: home).first { $0.value["url"] as? String == url }?.id ?? "" }
    let a = item("https://a.example/"), b = item("https://b.example/")
    check("pin requests: set up: two web items, the second shown", !a.isEmpty && !b.isEmpty && session.shown[1] == b, "\(library.items(space: home).map(\.id))")
    // A pin and a favourite to bind new items to (a third item pinned, the fourth a favourite).
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://pin.example/"]) }
    let pinned = item("https://pin.example/")
    let pin = library.perform("pinTab", ["windowId": 1, "tabId": pinned]).result as? String ?? ""
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://fav.example/"]) }
    let faved = item("https://fav.example/")
    let fav = library.perform("addFavorite", ["windowId": 1, "tabId": faved]).result as? String ?? ""
    check("pin requests: set up: a pin and a favourite", !pin.isEmpty && !fav.isEmpty, "\(pin) \(fav)")
    func ask(_ type: String, _ body: JSONObject) { session.library(library, wants: LibraryRequest(type: type, body: body)) }
    func shows(since mark: Int) -> [String] { links.asked.dropFirst(mark).filter { $0.type == "hostShow" }.compactMap { $0.payload["itemId"] as? String } }
    func navigates(since mark: Int) -> [JSONObject] { links.asked.dropFirst(mark).filter { $0.type == "hostNavigate" }.map(\.payload) }
    let kinds: [(open: String, reset: String, key: String, bound: String, id: String)] = [("openPin", "resetPin", "pin", "pinnedBy", pin), ("openFavorite", "resetFavorite", "favorite", "favoriteId", fav)]
    for k in kinds {
        // Opened with its item: that item shown at the address the request names, nothing navigated, nothing made.
        var mark = links.asked.count, items = library.items().count
        run { ask(k.open, ["type": k.open, "windowId": 1, "item": a, "url": "https://a.example/", "target": web.json, k.key: k.id, "spaceId": home]) }
        check("pin requests: \(k.open) with its item: that item shown, nothing navigated, no item made",
              session.shown[1] == a && shows(since: mark) == [a] && navigates(since: mark).isEmpty && library.items().count == items, "\(shows(since: mark)) \(String(describing: session.shown[1]))")
        // Opened with none: an item made at its address, in front, bound to it (`pinnedBy`/`favoriteId`), and shown.
        mark = links.asked.count
        run { ask(k.open, ["type": k.open, "windowId": 1, "item": NSNull(), "url": "https://\(k.key)-new.example/", "target": web.json, k.key: k.id, "spaceId": home]) }
        let fresh = item("https://\(k.key)-new.example/")
        let value = library.items().first { $0.id == fresh }?.value ?? [:]
        check("pin requests: \(k.open) with none: an item made at its address, bound to it, shown",
              !fresh.isEmpty && value[k.bound] as? String == k.id && session.shown[1] == fresh && shows(since: mark) == [fresh], "\(value) \(shows(since: mark))")
        // Opened with none, and addItem refuses (no address): said, nothing shown.
        mark = links.asked.count
        var done = session.done.count
        items = library.items().count
        run { ask(k.open, ["type": k.open, "windowId": 1, "item": NSNull(), "target": web.json, k.key: k.id, "spaceId": home]) }
        check("pin requests: \(k.open) with none, addItem refused: said in its words, nothing shown or made",
              session.done.dropFirst(done).contains("\(k.open): no item made (no address)") && shows(since: mark).isEmpty && library.items().count == items && session.shown[1] == fresh,
              "\(session.done.dropFirst(done))")
        // Opened with its item, overtaken (another item asked for before its turn): skipped with its line.
        mark = links.asked.count
        done = session.done.count
        run {
            ask(k.open, ["type": k.open, "windowId": 1, "item": a, "url": "https://a.example/", "target": web.json, k.key: k.id, "spaceId": home])
            _ = library.perform("activateTab", ["windowId": 1, "tabId": b])
        }
        check("pin requests: \(k.open) overtaken before its turn: skipped with its line, the later pick shown",
              session.done.dropFirst(done).contains("\(a): not shown, \(b) asked for since") && shows(since: mark) == [b] && session.shown[1] == b, "\(session.done.dropFirst(done)) \(shows(since: mark))")
        // Reset with its item, open in the profile's copy: its tab navigated back to the address first, then shown.
        mark = links.asked.count
        run { ask(k.reset, ["type": k.reset, "windowId": 1, "item": a, "url": "https://a.example/root", "target": web.json, k.key: k.id, "spaceId": home]) }
        let nav = navigates(since: mark)
        let order = links.types(since: mark).filter { $0 == "hostNavigate" || $0 == "hostShow" }
        check("pin requests: \(k.reset) with its item open: its tab navigated back first (its item, its address), then shown",
              nav.count == 1 && nav[0]["itemId"] as? String == a && nav[0]["url"] as? String == "https://a.example/root" && order == ["hostNavigate", "hostShow"]
              && session.shown[1] == a, "\(nav) \(order)")
        // Reset with its item, not open: nothing navigated, shown.
        let closedItem = (library.perform("addItem", ["windowId": 1, "url": "https://\(k.key)-shut.example/", "target": web.json]).result as? JSONObject)?["tabId"] as? String ?? ""
        mark = links.asked.count
        run { ask(k.reset, ["type": k.reset, "windowId": 1, "item": closedItem, "url": "https://\(k.key)-shut.example/", "target": web.json, k.key: k.id, "spaceId": home]) }
        check("pin requests: \(k.reset) with its item not open: nothing navigated, shown",
              session.open[closedItem] != nil && navigates(since: mark).isEmpty && shows(since: mark) == [closedItem] && session.shown[1] == closedItem, "\(links.types(since: mark))")
        // Reset with no address: nothing at all.
        mark = links.asked.count
        done = session.done.count
        run { ask(k.reset, ["type": k.reset, "windowId": 1, "item": a, "target": web.json, k.key: k.id, "spaceId": home]) }
        check("pin requests: \(k.reset) with no address: nothing asked, nothing said", links.asked.count == mark && session.done.count == done && session.shown[1] == closedItem)
        // Reset with none: an item made at its address, bound, shown.
        mark = links.asked.count
        run { ask(k.reset, ["type": k.reset, "windowId": 1, "item": NSNull(), "url": "https://\(k.key)-reset.example/", "target": web.json, k.key: k.id, "spaceId": home]) }
        let reset = item("https://\(k.key)-reset.example/")
        check("pin requests: \(k.reset) with none: an item made at its address, bound to it, shown",
              !reset.isEmpty && library.items().first { $0.id == reset }?.value[k.bound] as? String == k.id && session.shown[1] == reset && shows(since: mark) == [reset], "\(shows(since: mark))")
        // Reset with none, addItem refused: nothing said (unlike an open), nothing shown.
        mark = links.asked.count
        done = session.done.count
        items = library.items().count
        run { ask(k.reset, ["type": k.reset, "windowId": 1, "item": NSNull(), "url": "", "target": web.json, k.key: k.id, "spaceId": home]) }
        check("pin requests: \(k.reset) with none, addItem refused: silent, nothing shown or made",
              session.done.count == done && shows(since: mark).isEmpty && library.items().count == items && session.shown[1] == reset, "\(session.done.dropFirst(done))")
        // Reset with its item, overtaken (another item asked for meanwhile): never skipped, the reset's item shown, then the pick.
        mark = links.asked.count
        done = session.done.count
        run {
            ask(k.reset, ["type": k.reset, "windowId": 1, "item": a, "url": "https://a.example/", "target": web.json, k.key: k.id, "spaceId": home])
            _ = library.perform("activateTab", ["windowId": 1, "tabId": b])
        }
        check("pin requests: \(k.reset) overtaken: not skipped (navigated, shown), then the later pick shown",
              !session.done.dropFirst(done).contains { $0.contains("not shown") } && navigates(since: mark).count == 1 && shows(since: mark) == [a, b] && session.shown[1] == b,
              "\(session.done.dropFirst(done)) \(shows(since: mark))")
    }
    run { await engine.quitAll() }
}

// ---- which panes leave a split laid out without room (HostedSession.noRoom), at its edges ----

private func noRoomEdgeTests() {
    let page = CGRect(x: 240, y: 41, width: 1264, height: 933)
    let least = HostedSession.paneLeast
    typealias Pane = (item: String, role: HostRole, rect: CGRect?, least: CGSize?)
    func room(_ panes: [Pane], had: Set<String> = []) -> [String]? { HostedSession.noRoom(panes, page: page, had: had) }
    let full = CGRect(x: 240, y: 41, width: 628, height: 933)
    check("no room edges: a pane exactly 1 pt past each edge of the page area still fits (the slack)",
          room([("m", .main, CGRect(x: 239, y: 40, width: 629, height: 935), least), ("p", .pane, CGRect(x: 876, y: 41, width: 629, height: 934), least)]) == nil)
    check("no room edges: past it by a hair: out (the newcomer)",
          room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 41, width: 629.001, height: 933), least)]) == ["p"])
    check("no room edges: above or below the area by more than 1 pt: out",
          room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 39.99, width: 300, height: 933), least)]) == ["p"]
          && room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 41, width: 300, height: 934.01), least)]) == ["p"])
    check("no room edges: 1 pt under the least still fits (219 wide), less doesn't",
          room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 41, width: 219, height: 933), least)]) == nil
          && room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 41, width: 218.99, height: 933), least)]) == ["p"]
          && room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 41, width: 628, height: 218.99), least)]) == ["p"])
    check("no room edges: no least known: only the page area counts", room([("m", .main, full, nil), ("p", .pane, CGRect(x: 876, y: 41, width: 10, height: 10), nil)]) == nil)
    check("no room edges: a pane with no rect never counts as cramped", room([("m", .main, nil, least), ("p", .pane, nil, least)]) == nil)
    check("no room edges: a negative-width rect is measured as CoreGraphics does (standardized: 200 wide, out)",
          room([("m", .main, full, least), ("p", .pane, CGRect(x: 1100, y: 41, width: -200, height: 933), least)]) == ["p"])
    check("no room edges: main cramped, the others had: the last pane goes (main never)",
          room([("m", .main, CGRect(x: 240, y: 41, width: 100, height: 933), least), ("p", .pane, CGRect(x: 876, y: 41, width: 300, height: 933), least), ("q", .pane, CGRect(x: 1180, y: 41, width: 300, height: 933), least)], had: ["m", "p", "q"]) == ["q"])
    check("no room edges: the cramped ones (not main) before the last, when every pane was had",
          room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 41, width: 100, height: 933), least), ("q", .pane, CGRect(x: 1180, y: 41, width: 300, height: 933), least)], had: ["m", "p", "q"]) == ["p"])
    check("no room edges: every newcomer goes first (in order), not only the cramped one",
          room([("m", .main, full, least), ("p", .pane, CGRect(x: 876, y: 41, width: 300, height: 933), least), ("q", .pane, CGRect(x: 1180, y: 41, width: 100, height: 933), least)], had: ["m"]) == ["p", "q"])
    check("no room edges: a card is never a pane (its rect never cramps, never chosen)",
          room([("m", .main, full, least), ("k", .card, CGRect(x: -5000, y: 0, width: 1, height: 1), least)]) == nil
          && room([("m", .main, CGRect(x: 0, y: 0, width: 10, height: 10), least), ("k", .card, full, least)]) == nil)
    check("no room edges: main alone cramped: nothing to take out (main never), so nil", room([("m", .main, CGRect(x: 0, y: 0, width: 10, height: 10), least)]) == nil)
    check("no room edges: a zero-size page area: every rect past it", HostedSession.noRoom([("m", .main, full, least), ("p", .pane, full, least)], page: .zero, had: []) == ["p"])
}

// ---- the item a Margin window showed last (HostedSession.lastItem) and its loader's app ----

private func lastItemTests() {
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("last-item")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    let web = ItemTarget.web(browser: "safari", profile: nil).json
    func tab(_ space: String, _ selected: Any?, _ lastUsed: Any?, _ title: Any? = nil, target: JSONObject = web) -> JSONObject {
        var v: JSONObject = ["spaceId": space, "url": "https://x.example/", "target": target, "order": 1]
        if let selected { v["selected"] = selected }
        if let lastUsed { v["lastUsed"] = lastUsed }
        if let title { v["title"] = title }
        return v
    }
    let entries: [JSONObject] = [
        ["collection": "spaces", "id": "s1", "value": ["name": "One", "order": 0]],
        ["collection": "spaces", "id": "s2", "value": ["name": "Two", "order": 1]],
        ["collection": "spaces", "id": "s3", "value": ["name": "Three", "order": 2]],
        ["collection": "spaces", "id": "s4", "value": ["name": "Four", "order": 3]],
        ["collection": "spaces", "id": "s5", "value": ["name": "Five", "order": 4]],
        ["collection": "windows", "id": "2", "value": ["spaceId": "s2"]],
        ["collection": "windows", "id": "3", "value": ["spaceId": "s3"]],
        ["collection": "windows", "id": "4", "value": ["spaceId": "s4"]],
        ["collection": "windows", "id": "5", "value": ["spaceId": "s5"]],
        ["collection": "windows", "id": "6", "value": ["spaceId": "nowhere"]],
        // s1 (a window with no space of its own: the first space): two selected at the same time, the smallest id wins.
        ["collection": "tabs", "id": "t-b", "value": tab("s1", true, 50, "B")],
        ["collection": "tabs", "id": "t-a", "value": tab("s1", true, 50, "A")],
        ["collection": "tabs", "id": "t-c", "value": tab("s1", false, 90, "C")],
        // s2: the newest selected; a number 1 is selected (Swift's `as? Bool`), "true" isn't; no lastUsed is 0.
        ["collection": "tabs", "id": "u-a", "value": tab("s2", true, nil, "")],
        ["collection": "tabs", "id": "u-b", "value": tab("s2", 1, 7, "")],
        ["collection": "tabs", "id": "u-c", "value": tab("s2", "true", 99, "x")],
        // s3: an app's item (its name: the app's, else the item's, else its bundle id), s4: another browser's (none), s5: Margin's page.
        ["collection": "tabs", "id": "v-a", "value": tab("s3", true, 3, target: ItemTarget.app(bundleId: "com.example.Unnamed", name: "").json)],
        ["collection": "tabs", "id": "w-a", "value": tab("s4", true, 3, target: ItemTarget.web(browser: "chrome", profile: nil).json)],
        ["collection": "tabs", "id": "x-a", "value": tab("s5", true, 3, "", target: ItemTarget.margin(page: "settings").json)],
    ]
    let core = LibraryCore(root: Library.folder(in: dataRoot), background: false)
    _ = core.apply(entries, at: 1000)
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("last item: the library opens", false)
    }
    let session = HostedSession(library: library, engine: StubLaunchEngine(), links: FakeHostedLinks())
    session.appName = { _ in nil }
    let last = { (w: Int) in session.lastItem(ofWindow: w).map { "\($0.item) \($0.name)" } }
    check("last item: a window with no space: the first space's; two selected at the same time: the smallest id", last(1) == "t-a A", "\(String(describing: last(1)))")
    check("last item: a number 1 counts as selected, a string doesn't; no lastUsed is 0; no title: Safari", last(2) == "u-b Safari", "\(String(describing: last(2)))")
    check("last item: an app's item with no name: its bundle id", last(3) == "v-a com.example.Unnamed", "\(String(describing: last(3)))")
    session.appName = { $0 == "com.example.Unnamed" ? "Unnamed App" : nil }
    check("last item: an app's item: the app's own name first", last(3) == "v-a Unnamed App", "\(String(describing: last(3)))")
    check("last item: another browser's item: none (not hosted yet)", last(4) == nil)
    check("last item: Margin's page with no title: Margin", last(5) == "x-a Margin", "\(String(describing: last(5)))")
    check("last item: a window whose space has no items: none", last(6) == nil)
    check("loader app: an app's own, Safari for a web item, none for Margin's page",
          HostedSession.loaderApp(.app(bundleId: "com.apple.Notes", name: "Notes")) == "com.apple.Notes" && HostedSession.loaderApp(.web(browser: "chrome", profile: "p")) == safariIdentifier
          && HostedSession.loaderApp(.margin(page: "settings")) == nil)
    let links = FakeHostedLinks()
    let choice = HostedSession(library: library, engine: StubLaunchEngine(), links: links)
    let d = HostedSession.defaultSafariProfile
    check("resolve: a profile of its own: itself; nothing linked: the default's", choice.resolve("p-x") == "p-x" && choice.resolve(nil) == d)
    links.profiles = ["zz", d, "aa"]
    check("resolve: the default's copy linked: the default's", choice.resolve(nil) == d)
    links.profiles = ["zz", "aa", "mm"]
    check("resolve: only others linked: the first in order", choice.resolve(nil) == "aa")
}

// ---- a web address (HostedPeek.webAddress: Foundation's URL(string:), at most 2,048 characters, http or https) ----

private func webAddressTests() {
    let yes = ["http:", "https://", "HTTP://A", "http://a/b c", "http://a/%zz", "http://a:80/", "http://[::1]/", "http://[zz]/", "http://a%20b/", "http://é.com/",
               "http://a/é", "http://a/\n", "http://u:p@@a/", "http://u@a@b/", "http://a:/", "http://a:99999999999/", "http://:80/", "http://[::1%en0]/", "http://[]/",
               "https:x y", "http://a!$&'()*+,;=b/", "http://a😀/", "http://ab.שלום/", "http://Ⓐ/", "https://docs.example.org/guide?q=1#top"]
    let no = ["", " http://a/", "http://a b", "http://a:xx/", "http://a:-1/", "http://[::1/", "http://a]b/", "http://a%zzb/", "http://a\\b/", "http://a^b/", "http://[::1]x/",
              "http://a:80:80/", "http://a:８０/", "http://-é/", "http://aש/", "http://a\u{200D}b/", "http://[é]/", "javascript:alert(1)", "about:blank", "ftp://a/",
              "file:///etc/hosts", ":http://a", "http//a", "ht+tp://a"]
    let wrongYes = yes.filter { !HostedSession.webAddress($0) }, wrongNo = no.filter { HostedSession.webAddress($0) }
    check("web address: accepted as Foundation's URL(string:) does (invalid characters encoded, hosts by IDNA)", wrongYes.isEmpty, "\(wrongYes)")
    check("web address: refused: not http(s), or what URL(string:) can't make (the host, the port, the scheme)", wrongNo.isEmpty, "\(wrongNo)")
    let head = "https://a/"
    let at = head + String(repeating: "x", count: 2048 - head.count)
    check("web address: 2,048 characters at most", HostedSession.webAddress(at) && !HostedSession.webAddress(at + "x"))
    // (Characters: a combining mark makes no character of its own.)
    let marks = head + String(repeating: "x", count: 2047 - head.count) + "e\u{301}"
    check("web address: counted in characters (2,048 of them, 2,049 Unicode scalars)", marks.count == 2048 && marks.unicodeScalars.count == 2049 && HostedSession.webAddress(marks))
}

// ---- a search's address (LibraryWindowSource.searchUrl) ----

private func searchUrlTests() {
    let google = "https://www.google.com/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8"
    let q = { (query: String) in LibraryWindowSource.searchUrl(query, settings: nil).replacingOccurrences(of: "https://www.google.com/search?client=safari&rls=en&q=", with: "").replacingOccurrences(of: "&ie=UTF-8&oe=UTF-8", with: "") }
    check("search url: Google's when nothing's learned", LibraryWindowSource.searchUrl("x", settings: nil) == google.replacingOccurrences(of: "%s", with: "x"))
    check("search url: kept as is: ASCII letters and digits and -_.!~*'()", q("aZ09-_.!~*'()") == "aZ09-_.!~*'()")
    check("search url: encoded: space, & = + / ? # % : @ and the rest of ASCII", q(" &=+/?#%:@\"<>[]\\^`{|}$,;") == "%20%26%3D%2B%2F%3F%23%25%3A%40%22%3C%3E%5B%5D%5C%5E%60%7B%7C%7D%24%2C%3B", q(" &=+/?#%:@\"<>[]\\^`{|}$,;"))
    check("search url: encoded: controls", q("\t\n\u{7f}") == "%09%0A%7F", q("\t\n\u{7f}"))
    // (Foundation's addingPercentEncoding ignores whatever of the allowed set isn't ASCII: CharacterSet.alphanumerics's
    // Unicode letters, marks and digits are encoded like any other non-ASCII character, as encodeURIComponent does.)
    check("search url: every non-ASCII character encoded as UTF-8, letters, marks and digits too",
          q("café") == "caf%C3%A9" && q("e\u{301}") == "e%CC%81" && q("日本") == "%E6%97%A5%E6%9C%AC" && q("١٢") == "%D9%A1%D9%A2" && q("½Ⅻ") == "%C2%BD%E2%85%AB" && q("ß") == "%C3%9F", q("café") + " " + q("١٢"))
    check("search url: other Unicode encoded as UTF-8: symbols, punctuation, spaces, emoji",
          q("€") == "%E2%82%AC" && q("—") == "%E2%80%94" && q("\u{a0}") == "%C2%A0" && q("😀") == "%F0%9F%98%80" && q("«") == "%C2%AB", q("€") + q("😀"))
    check("search url: a learned engine's template (https, with %s), every %s filled",
          LibraryWindowSource.searchUrl("a b", settings: ["safariSearch": ["template": "https://e.example/?q=%s&again=%s"]]) == "https://e.example/?q=a%20b&again=a%20b")
    check("search url: a learned template that isn't one: Google's (no %s, not https, not a string)",
          [["template": "https://e.example/?q="], ["template": "http://e.example/?q=%s"], ["template": 5], [:]].allSatisfy { (t: JSONObject) in
              LibraryWindowSource.searchUrl("x", settings: ["safariSearch": t]).hasPrefix("https://www.google.com/") })
    check("search url: settings without a learned engine: Google's", LibraryWindowSource.searchUrl("x", settings: ["safariSearch": "nope"]).hasPrefix("https://www.google.com/"))
    check("search url: a query with %s in it isn't a template", q("%s") == "%25s")
}

// ---- the UI pushes' caps (UIPush.page) ----

private func uiPushCapTests() {
    let tab = { (entry: JSONObject) -> Int? in int(entry["tabId"]).map { $0 + 1000 } }
    let text140 = String(repeating: "a", count: 141)
    let toast = UIPush.page(["type": "toast", "text": text140, "extra": 1], tab: tab)
    check("ui push caps: a toast's text at 140 characters, nothing else passed", (toast?["text"] as? String)?.count == 140 && toast?["extra"] == nil && toast?["type"] as? String == "toast", "\(String(describing: toast))")
    let marks = String(repeating: "e\u{301}", count: 141)
    let cut = UIPush.page(["type": "toast", "text": marks], tab: tab)?["text"] as? String ?? ""
    check("ui push caps: counted in characters (a letter and its combining mark one)", cut.count == 140 && cut.unicodeScalars.count == 280, "\(cut.count) \(cut.unicodeScalars.count)")
    check("ui push caps: a text that isn't one: empty", UIPush.page(["type": "toast", "text": 5], tab: tab)?["text"] as? String == "")
    check("ui push caps: a type not passed on: none", UIPush.page(["type": "secret", "text": "x"], tab: tab) == nil && UIPush.page(["text": "x"], tab: tab) == nil)
    let image = "data:image/png;base64," + String(repeating: "A", count: UIPush.imageLimit - 22)
    func source(_ i: Int, _ extra: JSONObject = [:]) -> JSONObject {
        var s: JSONObject = ["tabId": i, "title": "t\(i)", "subtitle": "s", "artwork": image, "playing": true, "muted": false, "canPrev": NSNumber(value: 1), "canNext": "yes",
                             "updatedAt": 1700000000000.5, "pausedAt": NSNull()]
        for (k, v) in extra { s[k] = v }
        return s
    }
    var seen = 0
    let media = UIPush.page(["type": "media", "sources": (0..<20).map { source($0) } + ["not an object"]], tab: { e in seen += 1; return tab(e) })
    let sources = media?["sources"] as? [JSONObject] ?? []
    check("ui push caps: at most 8 sources passed, only the first 16 read (each one's tab asked)", sources.count == 8 && seen == 16, "\(sources.count) \(seen)")
    let first = sources.first ?? [:]
    check("ui push caps: a source's fields: its tab by the UI's number, an image at the limit kept, flags as Swift reads them, times rounded half away from zero",
          int(first["tabId"]) == 1000 && first["artwork"] as? String == image && first["canPrev"] as? Bool == true && first["canNext"] as? Bool == false
          && num(first["updatedAt"]) == 1700000000001 && first["pausedAt"] is NSNull && first.count == 10, "\(first.keys.sorted())")
    let big = UIPush.page(["type": "media", "sources": [source(1, ["artwork": image + "A", "updatedAt": -1, "pausedAt": 1e15, "subtitle": String(repeating: "b", count: 101)])]], tab: tab)
    let one = (big?["sources"] as? [JSONObject])?.first ?? [:]
    check("ui push caps: an image past 128 KB: none; a time before 1970 or past 1e15: 0 or none; a subtitle at 100",
          one["artwork"] is NSNull && num(one["updatedAt"]) == 0 && one["pausedAt"] is NSNull && (one["subtitle"] as? String)?.count == 100, "\(one)")
    let kinds = ["data:image/jpeg;base64,AAAA", "data:image/webp;base64,AA==", "data:image/gif;base64,A", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,AA=A", "data:image/png;base64,", "DATA:image/png;base64,AA"]
    let artwork = kinds.map { k in ((UIPush.page(["type": "media", "sources": [source(1, ["artwork": k])]], tab: tab)?["sources"] as? [JSONObject])?.first?["artwork"] as? String) != nil }
    check("ui push caps: images: PNG, JPEG, WebP, GIF in base64 only (no SVG, no padding inside, none empty, the prefix as written)", artwork == [true, true, true, false, false, false, false], "\(artwork)")
    let dropped = UIPush.page(["type": "media", "sources": [source(1), ["title": "no tab"], source(2)]], tab: { e in int(e["tabId"]) == 1 ? nil : tab(e) })
    check("ui push caps: a source whose tab isn't one of Margin's items: dropped", ((dropped?["sources"] as? [JSONObject])?.compactMap { int($0["tabId"]) }) == [1002], "\(String(describing: dropped))")
    check("ui push caps: the empty push of a standing type only", (UIPush.empty("media")?["sources"] as? [Any])?.isEmpty == true && UIPush.empty("toast") == nil && UIPush.standing == ["media"])
}

// ---- a host's logged form (HostID.description: never a profile's name) ----

private func hostIdLogTests() {
    let logged = { (raw: String) in HostID(raw: raw).description }
    check("host id logged: an app's as its bundle id", logged("com.apple.Notes") == "com.apple.Notes" && logged("app:com.x") == "app:com.x")
    check("host id logged: Safari's default profile, and its other roles", logged("safari:") == "safari:default" && logged("safari:#card") == "safari:default#card" && logged("safari:#pane2") == "safari:default#pane2")
    check("host id logged: a profile by its number (djb2 of its UTF-8, mod 10000)",
          logged("safari:Work") == "safari:p4872" && logged("safari:s-default") == "safari:p8010" && logged("safari:Ünïcødé") == "safari:p9586" && logged("safari:x") == "safari:p7693"
          && logged("safari:" + String(repeating: "z", count: 300)) == "safari:p8205", logged("safari:Work"))
    check("host id logged: a role after the number; a suffix that isn't a role is the profile's",
          logged("safari:Work#card") == "safari:p4872#card" && logged("safari:Work#pane1") == "safari:p4872#pane1" && logged("safari:a#b") == "safari:p3883"
          && logged("safari:Work#pane4") == "safari:" + logged("safari:Work#pane4").dropFirst(7) && logged("safari:Work#pane4") != "safari:p4872#pane4", logged("safari:a#b"))
}

// ---- the ground's holes (MarginWindowController.subtract, groundHoles): zero-size and touching rects ----

private func groundHoleTests() {
    let r = CGRect(x: 0, y: 0, width: 100, height: 100)
    let sub = MarginWindowController.subtract
    check("holes: a zero-size cut leaves the rect whole", sub(r, CGRect(x: 50, y: 50, width: 0, height: 0)) == [r] && sub(r, CGRect(x: 50, y: 0, width: 0, height: 100)) == [r])
    check("holes: a cut touching an edge (sharing it) leaves the rect whole",
          sub(r, CGRect(x: 100, y: 0, width: 50, height: 100)) == [r] && sub(r, CGRect(x: 0, y: -50, width: 100, height: 50)) == [r])
    check("holes: a cut apart leaves it whole, one covering it leaves nothing", sub(r, CGRect(x: 200, y: 200, width: 5, height: 5)) == [r] && sub(r, CGRect(x: -1, y: -1, width: 102, height: 102)).isEmpty)
    check("holes: a cut inside: above, below, left, right of it",
          sub(r, CGRect(x: 10, y: 20, width: 30, height: 40)) == [CGRect(x: 0, y: 0, width: 100, height: 20), CGRect(x: 0, y: 60, width: 100, height: 40), CGRect(x: 0, y: 20, width: 10, height: 40), CGRect(x: 40, y: 20, width: 60, height: 40)])
    check("holes: slivers of half a point or less left out", sub(r, CGRect(x: 0.5, y: 0.4, width: 99, height: 99.1)) == [CGRect(x: 99.5, y: 0.4, width: 0.5, height: 99.1)].filter { $0.width > 0.5 } && sub(r, CGRect(x: 0.6, y: 0, width: 99.4, height: 100)) == [CGRect(x: 0, y: 0, width: 0.6, height: 100)],
          "\(sub(r, CGRect(x: 0.6, y: 0, width: 99.4, height: 100)))")
    let holes = MarginWindowController.groundHoles
    let a = (rect: r, radii: [CGFloat]([6, 6, 6, 6])), touching = (rect: CGRect(x: 100, y: 0, width: 50, height: 100), radii: [CGFloat]([1, 2, 3, 4]))
    check("holes: touching holes both whole, each with its corners", holes([a, touching]) == [WindowGroundView.Hole(rect: a.rect, radii: a.radii), WindowGroundView.Hole(rect: touching.rect, radii: touching.radii)])
    check("holes: the same rect twice: the second leaves nothing", holes([a, a]) == [WindowGroundView.Hole(rect: r, radii: a.radii)])
    let zero = (rect: CGRect(x: 10, y: 10, width: 0, height: 0), radii: [CGFloat]([2, 2, 2, 2]))
    check("holes: a zero-size hole kept as it is, with its corners (nothing to cut it), and it cuts nothing after it",
          holes([a, zero]) == [WindowGroundView.Hole(rect: r, radii: a.radii), WindowGroundView.Hole(rect: zero.rect, radii: zero.radii)]
          && holes([zero, a]) == [WindowGroundView.Hole(rect: zero.rect, radii: zero.radii), WindowGroundView.Hole(rect: r, radii: a.radii)])
    let card = (rect: CGRect(x: 50, y: 50, width: 100, height: 100), radii: [CGFloat]([9, 9, 9, 9]))
    check("holes: an overlap: the later one's pieces, square", holes([a, card]) == [WindowGroundView.Hole(rect: r, radii: a.radii), WindowGroundView.Hole(rect: CGRect(x: 50, y: 100, width: 100, height: 50), radii: []),
                                                                                       WindowGroundView.Hole(rect: CGRect(x: 100, y: 50, width: 50, height: 50), radii: [])], "\(holes([a, card]))")
}

// ---- the pointer through several holes (PassThrough with `holes`, CatchRegion) ----

private func passThroughHoleTests() {
    let rect = CGRect(x: 100, y: 50, width: 400, height: 300)
    let left = CGRect(x: 100, y: 50, width: 196, height: 300), right = CGRect(x: 304, y: 50, width: 196, height: 300)
    var slot = Slot(rect: rect, holes: [left, right])
    let gets = { (x: CGFloat, y: CGFloat) in PassThrough.pageGets(CGPoint(x: x, y: y), slot) }
    check("pass-through holes: in a hole: the page's; in the gap between them: Margin's", gets(150, 100) && gets(400, 100) && !gets(300, 100))
    check("pass-through holes: a hole's edges as CGRect.contains (min in, max out)", gets(100, 50) && !gets(296, 100) && gets(304, 100) && !gets(500, 100) && !gets(150, 350))
    slot.holes = []
    check("pass-through holes: none (a card's content only, none open): Margin's everywhere", !gets(150, 100) && !gets(400, 100))
    slot.holes = [CGRect(x: 0, y: 0, width: 1000, height: 1000)]
    check("pass-through holes: a hole past the slot: only the slot's part", gets(150, 100) && !gets(50, 100) && !gets(600, 100))
    slot.holes = [CGRect(x: 150, y: 100, width: 0, height: 0), CGRect(x: 150, y: 100, width: 50, height: 0)]
    check("pass-through holes: zero-size holes take nothing", !gets(150, 100) && !gets(175, 100))
    slot.holes = [left, right]
    slot.hits = [CGRect(x: 120, y: 60, width: 20, height: 20)]
    check("pass-through holes: something drawn over a hole: Margin's", !gets(130, 70) && gets(150, 100))
    slot.hits = []
    slot.radius = 20
    check("pass-through holes: the slot's rounded corner still the theme's in a hole", !gets(101, 51) && gets(110, 80) && gets(400, 200))
    slot.captureAll = true
    check("pass-through holes: the whole window asked: Margin's", !gets(150, 100))
    slot.captureAll = false
    slot.radius = 0
    // The catch region: the holes in the frame's coordinates, cut to the slot, empty ones left out.
    let frame = CGRect(x: 50, y: 25, width: 600, height: 400)
    slot.holes = [left, right, CGRect(x: 120, y: 60, width: 0, height: 10), CGRect(x: 0, y: 0, width: 120, height: 60)]
    let region = CatchRegion.of(frame: frame, slot: slot)
    check("pass-through holes: the catch region's holes: offset into the frame, cut to the slot, empty ones gone",
          region.holes == [CGRect(x: 50, y: 25, width: 196, height: 300), CGRect(x: 254, y: 25, width: 196, height: 300), CGRect(x: 50, y: 25, width: 20, height: 10)], "\(String(describing: region.holes))")
    let probes = [(150, 100), (300, 100), (400, 100), (110, 55), (130, 70), (600, 300), (99, 49)].map { CGPoint(x: CGFloat($0.0), y: CGFloat($0.1)) }
    check("pass-through holes: the catch region fills exactly what the page doesn't get",
          probes.allSatisfy { region.contains(CGPoint(x: $0.x - frame.minX, y: $0.y - frame.minY), in: frame.size) == !PassThrough.pageGets($0, slot) })
    slot.holes = nil
    check("pass-through holes: no holes (one host): the whole slot", gets(300, 100) && CatchRegion.of(frame: frame, slot: slot).holes == nil)
}

// ---- the page's layout report (PageLayout(geometry:)) ----

private func pageLayoutReportTests() {
    let base: JSONObject = ["insets": ["left": 260, "top": 8, "right": 8, "bottom": 8], "container": ["width": 1512, "height": 949]]
    func layout(_ extra: JSONObject) -> PageLayout? {
        var g = base
        for (k, v) in extra { g[k] = v }
        return PageLayout(geometry: g)
    }
    let bare = layout([:])
    check("layout report: only insets and a size: no radius, four of it, full screen, no fills, no split",
          bare?.radius == 0 && bare?.radii == [0, 0, 0, 0] && bare?.mode == "fullscreen" && bare?.fills == [] && bare?.split == nil && bare?.panes == [] && bare?.outside == false && bare?.hosted == false)
    check("layout report: a negative radius kept from going below 0, the radii as given or four of the radius",
          layout(["radius": -3])?.radius == 0 && layout(["radius": -3])?.radii == [-3, -3, -3, -3] && layout(["radius": 4, "radii": [1, 2, 3]])?.radii == [4, 4, 4, 4]
          && layout(["radius": 4, "radii": [1, "2", 3, 4, 5]])?.radii == [1, 3, 4, 5])
    check("layout report: pageOutside and pageHosted as Swift reads a bool (a number 1 is one)",
          layout(["pageOutside": NSNumber(value: 1), "pageHosted": true])?.outside == true && layout(["pageOutside": NSNumber(value: 1), "pageHosted": true])?.hosted == true
          && layout(["pageOutside": "true", "pageHosted": NSNumber(value: 2)])?.outside == false && layout(["pageOutside": "true", "pageHosted": NSNumber(value: 2)])?.hosted == false)
    check("layout report: a mode that isn't a string: full screen", layout(["mode": 3])?.mode == "fullscreen" && layout(["mode": "windowed"])?.mode == "windowed")
    let fills = layout(["fills": ["#111", 2, String(repeating: "c", count: 81), "#444", "#555"]])?.fills
    check("layout report: fills: the first four, one that isn't a string or is past 80 characters empty", fills == ["#111", "", "", "#444"], "\(String(describing: fills))")
    check("layout report: fills: fewer than four: none", layout(["fills": ["#111", "#222"]])?.fills == [])
    check("layout report: fills: 80 characters counted as characters", layout(["fills": [String(repeating: "e\u{301}", count: 80), "a", "b", "c"]])?.fills.first?.count == 80)
    let pane = { (id: Any, rect: [Any]) -> JSONObject in ["id": id, "rect": rect] }
    let two = layout(["split": "sp-1", "panes": [pane("a", [260, 8, 600, 900]), pane("b:c.d_e-f", [870, 8, 600, 900])]])
    check("layout report: a split of two panes, each its item and box", two?.split == "sp-1" && two?.panes == [PagePane(item: "a", rect: CGRect(x: 260, y: 8, width: 600, height: 900)), PagePane(item: "b:c.d_e-f", rect: CGRect(x: 870, y: 8, width: 600, height: 900))])
    let refused: [JSONObject] = [
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1])]],
        ["split": "sp-1", "panes": (0..<5).map { pane("p\($0)", [0, 0, 1, 1]) }],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane("a", [2, 0, 1, 1])]],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane("b", [2, 0, 0, 1])]],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane("b", [2, 0, 1])]],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane("b", [2, 0, 1, true])]],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane("b c", [2, 0, 1, 1])]],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane("é", [2, 0, 1, 1])]],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane("", [2, 0, 1, 1])]],
        ["split": "sp-1", "panes": [pane("a", [0, 0, 1, 1]), pane(String(repeating: "x", count: 257), [2, 0, 1, 1])]],
        ["split": "sp 1", "panes": [pane("a", [0, 0, 1, 1]), pane("b", [2, 0, 1, 1])]],
        ["split": 7, "panes": [pane("a", [0, 0, 1, 1]), pane("b", [2, 0, 1, 1])]],
        ["split": "sp-1", "panes": "a"],
    ]
    let said = refused.map { layout($0).map { $0.split == nil && $0.panes.isEmpty } ?? false }
    check("layout report: not a split (one pane or five, an item twice, an empty box, three numbers, a bool, an id with a space, non-ASCII, empty, past 256, a bad split id): none, the layout kept",
          said.allSatisfy { $0 }, "\(said)")
    check("layout report: a 256-character item id is one", layout(["split": "s", "panes": [pane(String(repeating: "x", count: 256), [0, 0, 1, 1]), pane("b", [2, 0, 1, 1])]])?.panes.count == 2)
    check("layout report: not a report: a negative size, insets that aren't numbers", layout(["container": ["width": -1, "height": 10]]) == nil && layout(["insets": ["left": "0", "top": 0, "right": 0, "bottom": 0]]) == nil)
}
