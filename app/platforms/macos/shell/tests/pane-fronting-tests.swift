// A split pane's first open as the real screen had it, 2026-11-21 14:29:59–14:30:00 (fix/pane-fronting), part of
// tests.swift's run: the library, the session, the real engine on the stand-in world (host-tests.swift `FakeHostWorld`,
// the real Mac's pacing, tiles on, its window server's order by the raises) and a stand-in copy playing Safari:
// - the pane's new window is born in full screen; Accessibility's raise never takes for it, before or after a move
//   between Spaces; it opens on a blank page with the keys in its address field, so Safari keeps its full-screen
//   toolbar out over its page until the copy moves the item's tab in from main's window (`hostShow`), and then Safari
//   puts main's window back in front of it;
// - then the page reports its panes' rects again (the session's `pageRectChanged`, as the real page does after a
//   layout), which fronted the pane a second time on the real screen: raise, its copy, out and back (~590 ms).
// A. one first open fronts once: side by side the panes don't overlap, so their order isn't chased (no raise again, no
//    copy asked, no move out and back), the focused pane only given the keys; stacked (a pane's toolbar against the
//    pane above), the order is still kept;
// B. the pane's loader is lifted only once its tab is in and its own toolbar rests;
// C. kept: born in full screen under the freeze, main kept until the pane is in.
import AppKit
import Foundation

func paneFrontingTests() {
    paneFrontingCase(stacked: false, restsAfter: 0.07)
    paneFrontingCase(stacked: true, restsAfter: 0.07)
    paneFrontingCase(stacked: false, restsAfter: nil)
    paneFrontingCase(stacked: true, restsAfter: 0.07, band: true)
}

// `restsAfter`: how long after the item's tab is in its toolbar is back up (nil: never, within the wait). `band`: stacked
// with the real page's 52 pt band above the Safari pane (else the stand-in's 8 pt gap, where its toolbar reaches into the
// pane above).
private func paneFrontingCase(stacked: Bool, restsAfter: Double?, band: Bool = false) {
    let name = band ? "pane fronting (stacked, a 52 pt band)" : stacked ? "pane fronting (stacked, an 8 pt gap)" : restsAfter == nil ? "pane fronting (its toolbar stays out)" : "pane fronting"
    let echo = Diagnostics.echo
    var lines: [String] = []
    Diagnostics.echo = { lines.append($0) }
    defer { Diagnostics.echo = echo }
    let dataRoot = tempFolder("pane-fronting")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    let library = Library.open(dataRoot: dataRoot, background: false)
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "pf\(n)x" } }
    let w = FakeHostWorld()
    w.tilesOn = true
    w.staged = true
    w.toolbarAbove = ["com.apple.Safari"]
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    session.now = { 1000 }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    if band { window.stackedGap = 52 }
    session.window = { id in id == nil || id == 1 ? window : nil }
    engine.requestSafariWindow = { await session.requestSafariWindow($0) }
    engine.requestRoleWindow = { await session.requestSafariWindow($0, role: $1) }
    engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
    engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
    engine.safariFocus = { await session.safariFocus($0, $1) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.hostedWindow = { session.hosted($0) }
    engine.hostedWindows = { session.hostedWindows($0) }
    engine.onMinimum = { session.minimum($0) }
    engine.onAppMinimums = { session.appMinimumsChanged() }
    engine.loading = { session.loading($0) }
    var copyWindows: [Int: Int] = [:]
    var playing = false // (Safari's ways from the split's set-up on)
    var mainWindow = -1
    links.onNewWindow = { id, payload in
        guard let pid = w.running(bundleId: "com.apple.Safari").first?.pid else { return }
        let n = w.nextWindow
        w.nextWindow += 1
        w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop])
        w.apps[pid]?.windows.append(n)
        if payload["fullscreen"] as? Bool == true { w.bornFullScreen(n, switchAfter: 0.3); w.serverFrom[n] = w.clock + 0.4 }
        if playing {
            // (Made behind main, its raise never taking; a blank first page, the keys in its address field: its toolbar out.)
            w.raised.append(n)
            w.unraisable.insert(n)
            w.toolbarOut.insert(n)
            w.pageListedAt[n] = w.clock + 0.2 // (its page listed to Accessibility a little after the window: the real screen)
        } else {
            w.raised.insert(n, at: 0)
        }
        copyWindows[id] = n
    }
    links.onSetWindowState = { id, on in
        guard let n = copyWindows[id], let pid = w.wins[n]?.pid else { return }
        w.applyFullScreen(pid: pid, window: n, on)
    }
    links.onCloseWindow = { id in if let n = copyWindows.removeValue(forKey: id) { w.closeWindow(n) } }
    links.onFocusWindow = { _ in } // (Safari asked to put its window in front: it didn't take on the real screen)
    var shownIn: [Int] = []
    links.onHostShow = {
        guard playing, let id = int(links.asked.last?.payload["windowId"]), let n = copyWindows[id] else { return }
        shownIn.append(n)
        guard n != mainWindow else { return }
        // (The item's tab moved in from main's window, the blank page closed: the keys in the page, the toolbar back up
        // `restsAfter` later; and Safari puts main's window back in front of the pane's, unasked.)
        w.toolbarRestsAt[n] = restsAfter.map { w.clock + $0 } ?? .infinity
        w.raised.removeAll { $0 == mainWindow }
        w.raised.insert(mainWindow, at: 0)
    }
    window.splitShown = {
        guard let front = session.requested[1] ?? session.shown[1], let s = library.split(ofItem: front) else { return nil }
        return (s.id, s.panes, s.vertical, [])
    }
    func run(_ body: @escaping () async -> Void) { hostRun { await body(); await session.idle() } }
    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    links.profiles = ["s-default"]
    for url in ["https://a.example/", "https://b.example/"] { run { _ = library.perform("newTab", ["windowId": 1, "url": url]) } }
    func item(_ url: String) -> String { library.items(space: home).first { $0.value["url"] as? String == url }?.id ?? "" }
    let a = item("https://a.example/"), b = item("https://b.example/")
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": a]) }
    let safari = HostTarget.safariWindow("s-default").id, pane1 = HostTarget.safariWindow("s-default", .pane(1)).id
    func win(_ id: HostID) -> Int { engine.hosts[id]?.window ?? -1 }
    func bounds(_ id: HostID) -> CGRect? { engine.hosts[id].flatMap { w.bounds(window: $0.window) } }
    mainWindow = win(safari)
    check("\(name): set up: a web page shown alone in its profile's main window, its tile at the page area",
          session.shown[1] == a && engine.visible.count == 1 && engine.hosts[safari]?.tile != nil && mainWindow > 0, "\(engine.visible)")

    // ---- the split made from it, b (open in main's window) as its new pane, focused ----
    w.autoOnScreen = true
    w.byRaise = true
    w.moveFronts = true
    w.moveRaisable = false
    playing = true
    let mainWas = bounds(safari)
    var mainMovedEarly = false, paneInAt: Double?
    // (The pane's loader lifted: when, its window's toolbar then, its tab shown in it by then.)
    var lifted: (at: Double, toolbarOut: Bool, tabIn: Bool)?
    var paneWindow = -1
    window.onPaneLoading = {
        guard window.paneLoadingsSaid.last?.item == nil, window.paneLoadingsSaid.dropLast().last?.item == b, lifted == nil else { return }
        let n = win(pane1)
        lifted = (w.clock, w.isToolbarOut(n), shownIn.contains(n))
    }
    w.onClock = {
        let paneIn = engine.hosts[pane1].map { h in w.spaces(window: h.window) == [FakeHostWorld.marginSpace] && h.rect.map { w.bounds(window: h.window) == $0 } == true } ?? false
        if paneIn, paneInAt == nil { paneInAt = w.clock }
        if paneInAt == nil, !w.frozen, let now = bounds(safari), now != mainWas { mainMovedEarly = true }
    }
    let switches = w.switchesSeen, freezes = w.frozenFor.count
    let mark = w.calls.count, asks = links.asked.count
    lines = []
    let t0 = w.clock
    run { _ = library.perform("createSplit", ["windowId": 1, "panes": [a, b], "axis": stacked ? "vertical" : "horizontal"]) }
    let layoutEnd = w.clock
    paneWindow = win(pane1)
    // (The page's next report of its panes' rects, as the real page sends after a layout: the session places them again.)
    let reportAt = w.clock
    run { session.pageRectChanged(window) }
    let reportMs = Int((w.clock - reportAt) * 1000)
    w.onClock = nil
    let outAndBacks = lines.filter { $0.contains("host: \(pane1): out to a private Space and back") }
    let raisedAgain = lines.filter { $0.contains("\(pane1), focused, not in front") }
    let copyAsked = links.asked.dropFirst(asks).filter { $0.type == "hostFocusWindow" }
    let activations = w.calls.dropFirst(mark).filter { $0.hasPrefix("activate") }
    check("\(name): (the split shown, the pane focused, both at their rects)",
          session.layout[1]?.split != nil && engine.visible.count == 2 && engine.shown == pane1 && paneWindow > 0 && w.toolbarOf[paneWindow] != nil,
          "\(String(describing: session.layout[1])) \(engine.visible)")
    check("\(name) C: the pane born in full screen under one freeze, macOS's switch never seen, main kept until the pane was in",
          lines.contains { $0.contains("host: \(pane1): full screen by the early path") && $0.contains("born in full screen") }
          && w.switchesSeen == switches && w.frozenFor.count == freezes + 1 && !mainMovedEarly && paneInAt != nil,
          "\(w.switchesSeen - switches) \(w.frozenFor.dropFirst(freezes)) \(mainMovedEarly)")
    if stacked, !band {
        // (Stacked with a gap smaller than its toolbar: the pane's toolbar reaches into the pane above: their order is
        // kept, the pane in front of main.)
        check("\(name) A: stacked, the pane's toolbar against the pane above: its order kept (the pane in front of main), its keys",
              w.inFront(paneWindow, of: mainWindow) == true && activations.last?.hasSuffix(" \(paneWindow)") == true,
              "\(w.raised) \(activations.suffix(4))")
    } else {
        check("\(name) A: panes that don't overlap (side by side, or stacked across a 52 pt band), one first open fronts once: never moved out to a private Space and back, never raised again, its copy never asked",
              outAndBacks.isEmpty && raisedAgain.isEmpty && copyAsked.isEmpty,
              "out and back \(outAndBacks.count), raised again \(raisedAgain.count), copy asked \(copyAsked.count): \(lines.filter { $0.contains("front") })")
        check("\(name) A: …the page's next report of its panes doesn't front it again either (Safari put main in front: not chased, the panes don't overlap)",
              !lines.contains { $0.contains("raised again") } && w.inFront(mainWindow, of: paneWindow) == true,
              "\(w.raised)")
        check("\(name) A: …the focused pane has the keys (its app made active, its window last)",
              activations.last?.hasSuffix(" \(paneWindow)") == true && engine.shown == pane1, "\(activations.suffix(4))")
    }
    let waited = lines.first { $0.contains("host: \(pane1): its full-screen toolbar out over its page by 52 pt at its reveal") }
    if restsAfter != nil {
        check("\(name) B: the pane's loader lifted only once its tab was in and its own full-screen toolbar rested (never out over its page revealed)",
              lifted.map { !$0.toolbarOut && $0.tabIn } == true && window.paneLoadingsSaid.last?.item == nil,
              "\(String(describing: lifted)) \(window.paneLoadingsSaid.suffix(3).map { $0.item ?? "nil" })")
        check("\(name) B: …resting by its reveal: its wait said (out by 52 pt, resting after ~70 ms), or its page given the keys first so none was needed",
              waited?.contains("resting after") == true || (waited == nil && w.pageFocused.contains(paneWindow)), "\(String(describing: waited)) \(w.pageFocused)")
    } else {
        // (Safari keeps its toolbar down while the keys are in the new window's address field, whatever comes after (the
        // real screen, 2026-11-21: a pane made at its page, or around its tab): its page given the keys under its loader,
        // the toolbar rests, then the keys back to the focused pane; before: revealed with the toolbar out after 0.5 s.)
        check("\(name) B: a toolbar that wouldn't go back up by itself: the new window's page given its keys under its loader, then revealed with its toolbar resting, the keys back to the focused pane",
              w.pageFocused.contains(paneWindow) && lifted.map { $0.tabIn && !$0.toolbarOut } == true && waited?.contains("still out") != true && window.paneLoadingsSaid.last?.item == nil
              && lines.contains { $0.contains("new windows' pages given their keys") },
              "\(String(describing: lifted)) \(String(describing: waited)) focused pages \(w.pageFocused)")
    }
    let liftMs = lifted.map { Int(($0.at - t0) * 1000) } ?? -1
    Diagnostics.echo = echo
    print("  (\(name), the stand-in: the layout \(Int((layoutEnd - t0) * 1000)) ms, the pane revealed at \(liftMs) ms, the page's next report \(reportMs) ms; out and back \(outAndBacks.count), raised again \(raisedAgain.count), copy asked \(copyAsked.count), \(activations.count) activations)")
}
