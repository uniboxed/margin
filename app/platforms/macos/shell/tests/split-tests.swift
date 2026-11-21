// Split View (docs/PEEK-SPLIT.md §4), part of tests.swift's run: the library's splits shown by the session on the real
// engine and the stand-in world. A split's item picked shows the whole split (main: its first web pane, in its
// profile's main window; a profile's other web panes in `#pane1`…, each opened at its page; an app as itself), the
// picked one focused, each pane at its `<m-pane>` as the window's page lays it out; another item picked parks the
// panes; a pane focused by a press; ⌘W closes the focused pane, the split going on, then ending at one; a divider's
// drag placing each window at its new rect; idle pane windows closed. The engine's side: a drag's frame tells Margin's
// window every pane's rect at once (its holes follow), and each visible host's off-screen budget is its own.
import AppKit
import Foundation

func splitTests() {
    splitEngineTests()
    splitSessionTests()
}

private func splitEngineTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-split-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let left = CGRect(x: 276, y: 41, width: 610, height: 933), right = CGRect(x: 894, y: 41, width: 610, height: 933)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func world(_ n: Int) -> (FakeHostWorld, HostEngine) {
        let w = FakeHostWorld()
        w.tilesOn = true
        let e = HostEngine(system: w, marker: folder.appendingPathComponent("\(n)/\(HostMarker.fileName)"), pid: 1)
        e.options.privateRetire = 0
        e.options.earlyFullScreen = false
        return (w, e)
    }
    func open(_ e: HostEngine, _ t: HostTarget) { _ = hostRun { await e.open(app: t, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) } }
    func split(_ e: HostEngine) -> [HostID: HostResult] {
        hostRun { await e.setLayout(main: textEdit, mainRect: left, extras: [HostExtra(target: notes, role: .pane, rect: right)], focused: nil, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) } ?? [:]
    }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }

    // ---- a divider's drag: Margin's window told every pane's rect in the frame it's asked, its holes following ----
    do {
        let (w, e) = world(1)
        var told: [[HostShownWindow]] = []
        e.hostedWindows = { told.append($0) }
        open(e, textEdit)
        _ = split(e)
        let edit = window(w, "com.apple.TextEdit"), n = window(w, "com.apple.Notes")
        let on = e.dragging(true)
        let left2 = CGRect(x: 276, y: 41, width: 410, height: 933), right2 = CGRect(x: 694, y: 41, width: 810, height: 933)
        let mark = told.count
        e.follow(placement, rects: [textEdit.id: left2, notes.id: right2])
        let atOnce = told.dropFirst(mark).last
        check("split: a divider's frame: Margin's window told each pane's rect in it at once (its holes follow the page, a frame before the windows at most)",
              on && atOnce == [HostShownWindow(window: edit, rect: left2, role: .main, z: 0, focused: true), HostShownWindow(window: n, rect: right2, role: .pane, z: 1, focused: false)],
              "\(on) \(String(describing: atOnce))")
        _ = hostRun { await w.sleep(0.05); return true }
        check("split: …and the windows follow (their tiles)", w.bounds(window: edit) == left2 && w.bounds(window: n) == right2,
              "\(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n)))")
        let count = told.count
        e.follow(placement, rects: [textEdit.id: left2, notes.id: right2])
        check("split: the same frame again: nothing said (no work for a frame that changed nothing)", told.count == count)
        _ = e.dragging(false)
        _ = hostRun { await e.pageRectChanged(placement, rects: [textEdit.id: left2, notes.id: right2]) }
        check("split: let go: each at its rect from now", e.visible[notes.id]?.rect == right2 && e.hosts[textEdit.id]?.rect == left2 && w.bounds(window: n) == right2)
    }

    // ---- each visible host's own off-screen budget: the pane's tries never use up main's ----
    do {
        let (w, e) = world(2)
        w.autoOnScreen = true
        open(e, textEdit)
        _ = split(e)
        let edit = window(w, "com.apple.TextEdit"), n = window(w, "com.apple.Notes")
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        defer { Diagnostics.echo = echo }
        func polls(_ k: Int) { for _ in 0..<k { w.clock += 0.25; e.poll(); _ = hostRun { await w.sleep(0.001); return true } } }
        // The pane's window off screen though it's in Margin's Space (its app ordered it out): acted on, once this show.
        w.orderedOut.insert(n)
        polls(3)
        let paneActed = lines.contains { $0.contains("host: \(notes.id): shown, not on screen though it's in Margin's Space") }
        w.orderedOut.remove(n)
        polls(2)
        // Then main's, in the same show: its own look acts too (before 2026-11-21 the pane's act was the show's only one).
        lines = []
        w.orderedOut.insert(edit)
        polls(3)
        let mainActed = lines.contains { $0.contains("host: \(textEdit.id): shown, not on screen though it's in Margin's Space") }
        let mainRefused = lines.contains { $0.contains("host: \(textEdit.id): shown, still not on screen in Margin's Space") }
        w.orderedOut.remove(edit)
        check("split: each visible host's own budget: the pane brought forward, then main in the same show (never refused by the pane's try)",
              paneActed && mainActed && !mainRefused, "\(paneActed) \(mainActed) \(mainRefused) \(lines.filter { $0.contains("on screen") }.suffix(4))")
    }
}

private func splitSessionTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("split")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("split session: the library opens (\(scriptPath): npm run build)", false)
    }
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "s\(n)x" } }
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
    // The page lays out the split of the item in front (the one asked for, else the one shown), as Margin's renderer
    // does; `ratios`: as the divider was dragged (the library's otherwise).
    var dragged: [CGFloat]?
    window.splitShown = {
        guard let front = session.requested[1] ?? session.shown[1], let s = library.split(ofItem: front) else { return nil }
        let saved = ((library.values["splits"] as? JSONObject)?[s.id] as? JSONObject)?["ratios"] as? [Double] ?? []
        return (s.id, s.panes, s.vertical, dragged ?? saved.map { CGFloat($0) })
    }
    func run(_ body: @escaping () async -> Void) { hostRun { await body(); await session.idle() } }
    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let edit = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""
    links.profiles = ["s-default"]
    for url in ["https://a.example/", "https://b.example/", "https://c.example/"] { run { _ = library.perform("newTab", ["windowId": 1, "url": url]) } }
    func item(_ url: String) -> String { library.items(space: home).first { $0.value["url"] as? String == url }?.id ?? "" }
    let a = item("https://a.example/"), b = item("https://b.example/"), c = item("https://c.example/")
    let safari = HostTarget.safariWindow("s-default").id, pane1 = HostTarget.safariWindow("s-default", .pane(1)).id, editId = HostTarget.app("com.apple.TextEdit").id
    func bounds(_ id: HostID) -> CGRect? { engine.hosts[id].flatMap { w.bounds(window: $0.window) } }
    func inMargin(_ id: HostID) -> Bool { engine.hosts[id].map { w.spaces(window: $0.window) == [FakeHostWorld.marginSpace] } ?? false }
    func panes() -> [String: CGRect] { Dictionary(uniqueKeysWithValues: (window.paneLayout?.panes ?? []).map { ($0.item, $0.rect) }) }
    check("split session: set up: three web items in the profile's main window, TextEdit open", !a.isEmpty && !b.isEmpty && !c.isEmpty && !edit.isEmpty && session.shown[1] == c)

    // ---- a split made: the whole split shown, the pane added focused ----
    var mark = links.asked.count
    run { _ = library.perform("createSplit", ["windowId": 1, "panes": [a, edit]]) }
    let sp = library.split(ofItem: a)?.id ?? ""
    var rects = panes()
    check("split session: a split made: shown whole, the web pane in the profile's main window at its <m-pane>, TextEdit at its own",
          session.layout[1]?.split == sp && session.layout[1]?.main == a && bounds(safari) == rects[a] && bounds(editId) == rects[edit] && inMargin(safari) && inMargin(editId)
          && rects[a].map { $0.maxX < (rects[edit]?.minX ?? 0) } == true, "\(String(describing: session.layout[1])) \(rects) \(String(describing: bounds(safari))) \(String(describing: bounds(editId)))")
    check("split session: …the pane added focused (the keys, the sidebar's highlight), a's tab shown in the main window",
          session.shown[1] == edit && engine.shown == editId && links.asked.dropFirst(mark).contains { $0.type == "hostShow" && $0.payload["itemId"] as? String == a && int($0.payload["windowId"]) == 90 },
          "\(String(describing: session.shown[1])) \(String(describing: engine.shown))")
    let live = session.live(library.snapshot())
    let tabs = ((live["openTabs"] as? JSONObject)?["tabs"] as? JSONObject) ?? [:]
    func tab(_ i: String) -> JSONObject? { tabs[String(session.number(ofItem: i))] as? JSONObject }
    check("split session: what the UI draws: the focused pane active, the other visible", tab(edit)?["active"] as? Bool == true && tab(a)?["visible"] as? Bool == true)

    // ---- a third pane, a web page of the same profile: its own pane window, opened at its page ----
    mark = links.asked.count
    run { _ = library.perform("addToSplit", ["windowId": 1, "tabId": b, "splitId": sp]) }
    rects = panes()
    let opened = links.asked.dropFirst(mark).first { $0.type == "newWindow" }
    check("split session: a pane of the same profile: a pane window asked of its copy, blank (its tab open in the main window is moved in), never the new-tab page",
          opened?.payload["url"] as? String == "about:blank" && session.safariWindows[SafariKey("s-default", .pane(1))] == 91
          && links.asked.dropFirst(mark).contains { $0.type == "hostShow" && $0.payload["itemId"] as? String == b && int($0.payload["windowId"]) == 91 }, "\(links.types(since: mark)) \(session.safariWindows)")
    check("split session: …three panes at their rects, b focused in its pane window",
          bounds(safari) == rects[a] && bounds(editId) == rects[edit] && bounds(pane1) == rects[b] && inMargin(pane1) && session.shown[1] == b && engine.shown == pane1
          && session.open[b]?.host == pane1 && engine.visible.count == 3, "\(rects) \(String(describing: bounds(pane1))) \(engine.visible)")

    // ---- a fourth, never opened: its pane window opened at its page; then removed from the split: the rest shown ----
    run { _ = library.perform("addItem", ["spaceId": home, "windowId": 1, "url": "https://d.example/", "title": "D"]) }
    let d = item("https://d.example/")
    mark = links.asked.count
    run { _ = library.perform("addToSplit", ["windowId": 1, "tabId": d, "splitId": sp]) }
    let pane2 = HostTarget.safariWindow("s-default", .pane(2)).id
    let openedD = links.asked.dropFirst(mark).first { $0.type == "newWindow" }
    check("split session: a pane never opened: its pane window opened at its page (the keys in its page, never the new-tab page)",
          !d.isEmpty && openedD?.payload["url"] as? String == "https://d.example/" && engine.visible.count == 4 && session.shown[1] == d && bounds(pane2) == panes()[d],
          "\(links.types(since: mark)) \(String(describing: openedD?.payload))")
    run { _ = library.perform("removeFromSplit", ["windowId": 1, "tabId": d]) }
    rects = panes()
    check("split session: Remove from Split View: the rest shown, its next pane focused, the removed one's window parked",
          library.split(sp)?.panes == [a, edit, b] && session.shown[1] == b && engine.visible.count == 3 && !inMargin(pane2) && bounds(pane1) == rects[b], "\(engine.visible)")

    // ---- an item outside it: shown alone, the panes parked; the split kept ----
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": c]) }
    check("split session: an item outside the split: shown alone, the panes' windows parked, the split kept for next time",
          session.shown[1] == c && session.layout[1] == nil && engine.visible.count == 1 && engine.shown == safari && !inMargin(pane1) && !inMargin(editId) && library.split(sp)?.panes == [a, edit, b],
          "\(String(describing: session.shown[1])) \(engine.visible)")

    // ---- a pane picked again (the sidebar's capsule): the whole split, that pane focused, its window reused ----
    mark = links.asked.count
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": a]) }
    rects = panes()
    check("split session: a pane picked: the whole split again, it focused, no window made again",
          session.layout[1]?.split == sp && session.shown[1] == a && engine.shown == safari && bounds(pane1) == rects[b] && bounds(editId) == rects[edit] && inMargin(pane1)
          && !links.types(since: mark).contains("newWindow"), "\(links.types(since: mark)) \(String(describing: session.layout[1]))")

    // ---- a press in a pane: it's focused ----
    session.pagePressed(window, at: CGPoint(x: rects[edit]!.midX, y: rects[edit]!.midY))
    run { await Task.yield() }
    hostRun { await session.idle(); for _ in 0..<5 { await Task.yield() } }
    check("split session: a press in another pane focuses it (the keys and the sidebar's highlight), nothing moved",
          session.shown[1] == edit && engine.shown == editId && session.layout[1]?.focused == edit && bounds(safari) == rects[a], "\(String(describing: session.shown[1]))")

    // ---- a field of Margin's let go of the keys (the palette closed): the focused pane has them again, never another ----
    let editWindowNumber = engine.hosts[editId]?.window ?? 0
    session.fieldClosed(window)
    hostRun { for _ in 0..<10 { await Task.yield() } }
    check("split session: the keys back after a field of Margin's: the focused pane's app fronted last (never main's)",
          w.calls.last { $0.hasPrefix("activate") }?.hasSuffix(" \(editWindowNumber)") == true, "\(w.calls.suffix(4))")

    // ---- a divider dragged (tiles off: each a plain member, placed again at the release) ----
    window.followingPage = false
    session.sidebarResizing(window, true)
    dragged = [1, 2, 1]
    session.pageRectChanged(window) // (each frame's layout: held while it's dragged)
    run {}
    let held = bounds(safari) == rects[a]
    session.sidebarResizing(window, false)
    run {}
    let after = panes()
    // (Before 2026-11-21 the focused pane's placing out of full screen and in made it the layout alone: the others
    // were never placed, and dropped out of the layout.)
    check("split session: a divider dragged: plain members held as they are meanwhile, each placed at its new rect at the release, the layout kept",
          held && after[a] != rects[a] && bounds(safari) == after[a] && bounds(editId) == after[edit] && bounds(pane1) == after[b] && session.layout[1]?.mainRect == after[a]
          && engine.visible.count == 3 && engine.shown == editId,
          "\(held) \(after) \(String(describing: bounds(safari))) \(String(describing: bounds(editId))) \(engine.visible)")
    dragged = nil

    // ---- ⌘W on the focused pane: the split goes on with the rest, its next pane focused ----
    run { _ = library.perform("closeTab", ["windowId": 1, "tabId": edit]) }
    rects = panes()
    check("split session: ⌘W on the focused pane: it's closed, the split shown with the rest, its next pane focused",
          library.split(sp)?.panes == [a, b] && session.layout[1]?.split == sp && session.shown[1] == b && !engine.isHosted(editId) && bounds(safari) == rects[a] && bounds(pane1) == rects[b],
          "\(String(describing: library.split(sp))) \(String(describing: session.layout[1])) \(String(describing: session.shown[1]))")

    // ---- ⌘W again: one pane left, shown alone (its tab moved back into the main window) ----
    mark = links.asked.count
    run { _ = library.perform("closeTab", ["windowId": 1, "tabId": b]) }
    check("split session: ⌘W on the last but one: the split ends, the one left shown alone in the profile's main window",
          library.split(sp) == nil && session.layout[1] == nil && session.shown[1] == a && engine.shown == safari && engine.visible.count == 1 && bounds(safari) == window.hostedPlacement?.page
          && links.asked.dropFirst(mark).contains { $0.type == "hostClose" && $0.payload["itemId"] as? String == b }, "\(String(describing: session.layout[1])) \(engine.visible)")

    // ---- the pane window unused: closed after 15 minutes ----
    session.closeIdlePaneWindows()
    clock += 60
    session.closeIdlePaneWindows()
    let early = session.safariWindows[SafariKey("s-default", .pane(1))] != nil
    clock += 900
    mark = links.asked.count
    session.closeIdlePaneWindows()
    run {}
    check("split session: a pane window unused for 15 minutes is closed by its copy (not before)",
          early && session.safariWindows[SafariKey("s-default", .pane(1))] == nil && links.asked.dropFirst(mark).contains { $0.type == "closeWindow" && int($0.payload["windowId"]) == 91 },
          "\(early) \(session.safariWindows) \(links.types(since: mark))")

    // ---- a pane window goes with its profile's main window ----
    run { _ = library.perform("createSplit", ["windowId": 1, "panes": [a, c]]) }
    let paneAgain = session.safariWindows[SafariKey("s-default", .pane(1))]
    mark = links.asked.count
    session.hostEvent(.windowClosed(safari))
    run {}
    check("split session: the profile's main window gone: its pane window closed by its copy with it",
          paneAgain != nil && session.safariWindows[SafariKey("s-default", .pane(1))] == nil && links.asked.dropFirst(mark).contains { $0.type == "closeWindow" && int($0.payload["windowId"]) == paneAgain },
          "\(String(describing: paneAgain)) \(session.safariWindows) \(links.types(since: mark))")
}
