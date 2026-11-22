// The preview card and Quick Tab, the session's side (HostedPeek.swift, docs/PEEK-SPLIT.md §2, §3), part of tests.swift's
// run: the library, the real engine on the stand-in world (tiles on) and a stand-in for the profile's copy. A page's
// click answered at once; the card window made at the card's page (never the new-tab page) in the card's role, laid
// out over the item at the page's <m-preview-page> (or Margin's default rect), focused, its own loader (never the page
// card's); ⌘W, a press around it, Esc in its page and its close parking it, never closing the item under it; a parked
// card shown again as a layout change (no new window, main never parked); hidden with its opener and shown again on
// return; Expand making the space's item of its page (its tab moved); a click given up on closing it; refusals; card
// windows closed after 15 minutes unused and with their profile's main window; Quick Tab.
import AppKit
import Foundation

func peekSessionTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("peek-session")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("peek session: the library opens (\(scriptPath): npm run build)", false)
    }
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "p\(n)x" } }
    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    var clock = 1000.0
    session.now = { clock }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    engine.requestSafariWindow = { await session.requestSafariWindow($0) }
    engine.requestRoleWindow = { await session.requestSafariWindow($0, role: $1) }
    engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
    engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.hostedWindow = { session.hosted($0) }
    engine.loading = { session.loading($0) }
    engine.hostedWindows = { session.hostedWindows($0) }
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
    let source = LibraryWindowSource(library: library, session: session, profileSource: DataSetWindowSource(data: DataSync(root: tempFolder("peek-profile")), pick: { nil }))
    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    links.profiles = ["s-default"]
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://a.example/"]) }
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://b.example/"]) }
    let aItem = library.items(space: home).first { $0.value["url"] as? String == "https://a.example/" }?.id ?? ""
    let bItem = library.items(space: home).first { $0.value["url"] as? String == "https://b.example/" }?.id ?? ""
    let main = HostTarget.safariWindow("s-default").id, cardId = HostTarget.safariWindow("s-default", .card).id
    let page = window.hostedPlacement?.page ?? .zero
    let rect = CGRect(x: 360, y: 150, width: 1044, height: 700)
    let mainWindow = engine.hosts[main]?.window ?? 0
    check("peek session: set up: a web item shown in the profile's main window (the copy's 90)",
          session.shown[1] == bItem && session.safariWindows == [SafariKey("s-default"): 90] && engine.shown == main && page.width > 1000, "\(session.safariWindows) \(page)")
    let itemShow = links.asked.last { $0.type == "hostShow" && $0.payload["itemId"] as? String == bItem }?.payload
    check("peek session: each item's hostShow says whether it's a pin's or favorite's (auto-preview: the copy has no library pins)",
          itemShow?["pinned"] as? Bool == false && session.pinnedOrFavorite(bItem) == false, "\(String(describing: itemShow))")
    func peeks(since mark: Int) -> [JSONObject] {
        window.pushed.dropFirst(mark).compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? JSONObject }.filter { $0["type"] as? String == "peek" }
    }
    func asked(_ type: String, since mark: Int) -> [JSONObject] { links.asked.dropFirst(mark).filter { $0.type == type }.map(\.payload) }
    let later = { Date().timeIntervalSince1970 * 1000 + 5000 }

    // ---- a page's Shift+click: answered at once, the card window made at its page, laid out at <m-preview-page> ----
    window.cardRect = rect
    var mark = links.asked.count, pmark = window.pushed.count, lmark = window.loadings.count
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-1", "url": "https://docs.example.org/guide", "source": "shift-click", "notAfter": later()]) }
    let answers = asked("peekAnswer", since: mark)
    check("peek session: a page's click answered yes at once, before anything else is asked of the copy",
          answers.count == 1 && answers[0]["id"] as? String == "peek-1" && answers[0]["ok"] as? Bool == true && links.asked.dropFirst(mark).first?.type == "peekAnswer", "\(links.types(since: mark))")
    let newWindows = asked("newWindow", since: mark)
    check("peek session: the card window asked of the copy at the card's page (never its empty new-tab page)",
          newWindows.count == 1 && newWindows[0]["url"] as? String == "https://docs.example.org/guide" && session.safariWindows[SafariKey("s-default", .card)] == 91, "\(newWindows) \(session.safariWindows)")
    let cardShows = asked("hostShow", since: mark).filter { $0["role"] as? String == "card" }
    check("peek session: its page shown there as the card's (the copy's tag, its window's role, a new page)",
          cardShows.count == 1 && cardShows[0]["itemId"] as? String == "peek-card" && int(cardShows[0]["windowId"]) == 91 && cardShows[0]["fresh"] as? Bool == true
          && cardShows[0]["url"] as? String == "https://docs.example.org/guide", "\(cardShows)")
    let cardWindow = engine.hosts[cardId]?.window ?? 0
    check("peek session: the card at the page's <m-preview-page>, focused (its keys), the item under it at the page area, still the one shown",
          w.bounds(window: cardWindow) == rect && w.spaces(window: cardWindow) == [FakeHostWorld.marginSpace] && engine.shown == cardId && engine.visible.count == 2
          && w.bounds(window: mainWindow) == page && w.spaces(window: mainWindow) == [FakeHostWorld.marginSpace] && session.shown[1] == bItem
          && session.layout[1]?.focused == HostedSession.cardItem("s-default"), "\(String(describing: w.bounds(window: cardWindow))) \(engine.visible) \(String(describing: session.layout[1]))")
    let said = peeks(since: pmark)
    check("peek session: the page told: the card loading (its own loader), then in place",
          said.count >= 2 && (said.first?["peek"] as? JSONObject)?["loading"] as? Bool == true && (said.last?["peek"] as? JSONObject)?["loading"] as? Bool == false
          && (said.last?["peek"] as? JSONObject)?["url"] as? String == "https://docs.example.org/guide", "\(said)")
    check("peek session: the card's first open never puts the page card's loader over main", window.loadings.count == lmark && window.loading == nil, "\(window.loadings.dropFirst(lmark))")
    let live = session.live(library.snapshot())
    let tabs = ((live["openTabs"] as? JSONObject)?["tabs"] as? JSONObject) ?? [:]
    check("peek session: the sidebar: the item under the card still highlighted, the card no row of its own (not the space's)",
          (tabs[String(session.number(ofItem: bItem))] as? JSONObject)?["active"] as? Bool == true && tabs.count == 2 && library.items(space: home).count == 2, "\(tabs.keys)")
    clock += 10

    // ---- ⌘W: the card closes, never the item under it ----
    mark = links.asked.count
    pmark = window.pushed.count
    var callMark = w.calls.count
    var out: JSONObject?
    run { out = source.perform("closeTab", ["windowId": 1]) }
    check("peek session: ⌘W (Margin's Close Tab) closes the card: parked, its tab closed by the copy, the item under it kept and focused again",
          out?["ok"] as? Bool == true && w.spaces(window: cardWindow) == [] && engine.shown == main && engine.visible.count <= 1 && session.shown[1] == bItem
          && library.items(space: home).contains { $0.id == bItem } && asked("hostCardClose", since: mark).count == 1 && asked("hostClose", since: mark).isEmpty
          && session.cards.isEmpty && session.layout[1] == nil, "\(String(describing: out)) \(engine.visible) \(links.types(since: mark))")
    check("peek session: …the page told first (it covers the card's page at once), main never parked for it",
          peeks(since: pmark).first?["peek"] is NSNull && !w.calls.dropFirst(callMark).contains { $0.hasPrefix("move \(mainWindow) ") && $0 != "move \(mainWindow) \(FakeHostWorld.marginSpace)" },
          "\(peeks(since: pmark)) \(w.calls.dropFirst(callMark))")

    // ---- a preview again: the parked card window comes back as a layout change (no new window, main never parked) ----
    mark = links.asked.count
    callMark = w.calls.count
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-2", "url": "https://second.example/", "notAfter": later()]) }
    let again = asked("hostShow", since: mark).filter { $0["role"] as? String == "card" }
    check("peek session: a parked card shown again: no new window, its page sent to the new address, at its rect, focused; main left where it is",
          asked("newWindow", since: mark).isEmpty && again.count == 1 && again[0]["fresh"] as? Bool == true && again[0]["url"] as? String == "https://second.example/"
          && w.bounds(window: cardWindow) == rect && w.spaces(window: cardWindow) == [FakeHostWorld.marginSpace] && engine.shown == cardId
          && !w.calls.dropFirst(callMark).contains { $0.hasPrefix("move \(mainWindow) ") && $0 != "move \(mainWindow) \(FakeHostWorld.marginSpace)" },
          "\(links.types(since: mark)) \(w.calls.dropFirst(callMark))")
    // Its keys back to Margin and back: never main raised over it.
    let raises = w.calls.count
    session.fieldClosed(window)
    run { await Task.yield() }
    let activations = w.calls.dropFirst(raises).filter { $0.hasPrefix("activate") }
    check("peek session: a field of Margin's letting go: the keys back to the card (fronted last), never main raised over it",
          engine.shown == cardId && activations.last?.hasSuffix(" \(cardWindow)") == true, "\(w.calls.dropFirst(raises))")

    // ---- switching away hides it with its opener (kept), coming back shows it again ----
    pmark = window.pushed.count
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": aItem]) }
    check("peek session: another item picked: the card hidden (parked, kept with its page), the page told",
          session.shown[1] == aItem && w.spaces(window: cardWindow) == [] && session.cards["s-default"]?.open == false && peeks(since: pmark).first?["peek"] is NSNull
          && engine.visible.count == 1, "\(String(describing: session.cards["s-default"])) \(engine.visible)")
    mark = links.asked.count
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": bItem]) }
    let back = asked("hostShow", since: mark).filter { $0["role"] as? String == "card" }
    check("peek session: back to its opener: the card shown again over it, its page kept (not sent anywhere)",
          session.shown[1] == bItem && w.bounds(window: cardWindow) == rect && w.spaces(window: cardWindow) == [FakeHostWorld.marginSpace] && engine.shown == cardId
          && session.cards["s-default"]?.open == true && back.count == 1 && back[0]["fresh"] == nil, "\(back) \(String(describing: session.cards["s-default"]))")

    // ---- a press on the dimmed page around it closes it ----
    mark = links.asked.count
    run { session.caughtPress(window, at: CGPoint(x: 300, y: 100)) }
    check("peek session: a press on the dimmed page around the card closes it", session.cards.isEmpty && w.spaces(window: cardWindow) == [] && engine.shown == main && asked("hostCardClose", since: mark).count == 1)

    // ---- Esc in the card's page (the copy's cardKey) closes it; ⌘↩ expands it ----
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-3", "url": "https://third.example/", "notAfter": later()]) }
    run { session.cardKey(profile: "s-default", windowId: 91, key: "close") }
    check("peek session: Esc in the card's page closes it", session.cards.isEmpty && w.spaces(window: cardWindow) == [] && engine.shown == main)
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-4", "url": "https://expand.example/page", "notAfter": later()]) }
    run { session.cardPage(profile: "s-default", windowId: 91, msg: ["url": "https://expand.example/page2", "title": "Page Two"]) }
    mark = links.asked.count
    run { session.cardKey(profile: "s-default", windowId: 91, key: "expand") }
    let expanded = library.items(space: home).first { $0.value["url"] as? String == "https://expand.example/page2" }
    let promote = asked("hostPromotePeek", since: mark)
    check("peek session: Expand: a new item of the space at the card's page (as it is now), its tab moved into the main window as that item's, shown as main",
          expanded != nil && expanded?.value["title"] as? String == "Page Two" && promote.count == 1 && promote[0]["fromItemId"] as? String == "peek-card"
          && int(promote[0]["toWindowId"]) == 90 && promote[0]["toItemId"] as? String == expanded?.id && session.shown[1] == expanded?.id && engine.shown == main
          && engine.visible.count <= 1 && w.spaces(window: cardWindow) == [] && session.cards.isEmpty, "\(String(describing: expanded)) \(promote) \(String(describing: session.shown[1]))")
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": bItem]) }

    // ---- refusals, and a click the copy gave up on ----
    mark = links.asked.count
    run { session.peekOpen(profile: "s-default", windowId: 7, msg: ["id": "peek-5", "url": "https://x.example/", "notAfter": later()]) }
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-6", "url": "https://x.example/", "notAfter": Date().timeIntervalSince1970 * 1000 - 10]) }
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-7", "url": "javascript:alert(1)", "notAfter": later()]) }
    let noes = asked("peekAnswer", since: mark)
    check("peek session: refused (the page opens the link itself): not a window Margin hosts, too late, not a web address",
          noes.map { $0["id"] as? String ?? "" } == ["peek-5", "peek-6", "peek-7"] && noes.allSatisfy { $0["ok"] as? Bool == false } && session.cards.isEmpty, "\(noes)")
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-8", "url": "https://late.example/", "notAfter": later()]) }
    run { session.peekCancel(profile: "s-default", msg: ["id": "peek-8"]) }
    check("peek session: the copy gave up on the click (its link opened in the page): the card closed again", session.cards.isEmpty && w.spaces(window: cardWindow) == [] && engine.shown == main)

    // ---- Margin's default rect: a theme with no <m-preview-page> ----
    window.cardRect = nil
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-9", "url": "https://default.example/", "notAfter": later()]) }
    let dflt = HostedSession.defaultCardRect(page: page)
    check("peek session: no <m-preview-page>: Margin's default place, centred with 8% and 7% margins under a 52 pt bar (the card window's toolbar rests under it)",
          w.bounds(window: cardWindow) == dflt && abs(dflt.minX - page.minX - (page.maxX - dflt.maxX)) <= 1 && abs(dflt.minX - page.minX - (page.width * 0.08).rounded()) <= 1
          && abs(dflt.minY - 52 - page.minY - (page.height * 0.07).rounded()) <= 1, "\(dflt) in \(page), at \(String(describing: w.bounds(window: cardWindow)))")
    let small = HostedSession.defaultCardRect(page: CGRect(x: 0, y: 0, width: 500, height: 400))
    check("peek session: the default card at least 420×320 (its page) in a small page area, centred", small.width == 420 && small.height == 320 && small.minX == 40 && small.minY == 66, "\(small)")
    run { _ = session.closeCard(windowId: 1, why: "test") }
    window.cardRect = rect

    // ---- unused for 15 minutes: the card window closed; its profile's main window gone: closed with it ----
    clock += 60
    session.sweepRestoredSafariWindows()
    run { await Task.yield() }
    check("peek session: a parked card window kept while it's been used lately", engine.isHosted(cardId))
    clock += HostedSession.cardIdle + 1
    mark = links.asked.count
    session.sweepRestoredSafariWindows()
    run { await Task.yield() }
    check("peek session: 15 minutes unused: the card window closed (by its copy), the main window left",
          !engine.isHosted(cardId) && engine.isHosted(main) && asked("closeWindow", since: mark).compactMap { int($0["windowId"]) } == [91], "\(links.types(since: mark))")
    run { session.peekOpen(profile: "s-default", windowId: 90, msg: ["id": "peek-10", "url": "https://fresh.example/", "notAfter": later()]) }
    let card2 = session.safariWindows[SafariKey("s-default", .card)]
    run { _ = session.closeCard(windowId: 1, why: "test") }
    check("peek session: the next preview after that makes a card window again", card2 != nil && card2 != 91, "\(String(describing: card2))")
    mark = links.asked.count
    run { await engine.close(main) }
    check("peek session: its profile's main window gone: the card window closed with it", !engine.isHosted(cardId) && asked("closeWindow", since: mark).count >= 1, "\(links.types(since: mark))")

    // ---- Quick Tab: its field, then a search's card; with nothing hosted, the space's new tab ----
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": aItem]) }
    run { session.littleArcOpened(windowId: 1, spaceId: home) }
    mark = links.asked.count
    run { out = source.perform("closeTab", ["windowId": 1]) }
    check("peek session: Quick Tab's field up: ⌘W closes it, never the item shown", out?["ok"] as? Bool == true && session.littleArcs.isEmpty && session.shown[1] == aItem
          && library.items(space: home).contains { $0.id == aItem } && asked("hostClose", since: mark).isEmpty)
    run { session.littleArcOpened(windowId: 1, spaceId: home) }
    run { out = source.perform("peek.go", ["windowId": 1, "query": "margin themes", "spaceId": home]) }
    let arc = session.cards["s-default"]
    check("peek session: Quick Tab's search: the card at the engine's search address over the item shown",
          out?["ok"] as? Bool == true && arc?.url.hasPrefix("https://www.google.com/search?") == true && arc?.url.contains("margin%20themes") == true && arc?.opener == aItem
          && engine.isHosted(cardId) && engine.shown == cardId, "\(String(describing: arc))")
    run { _ = session.closeCard(windowId: 1, why: "test") }
    run { await engine.parkShown(why: "test") }
    run { session.settleHosting() }
    let before = library.items(space: home).count
    run { session.littleArcGo(windowId: 1, url: "https://nothing-under.example/", spaceId: home) }
    check("peek session: Quick Tab with nothing hosted (the launcher): what's chosen opens as the space's new tab",
          library.items(space: home).count == before + 1 && library.items(space: home).contains { $0.value["url"] as? String == "https://nothing-under.example/" } && session.cards.isEmpty)
}
