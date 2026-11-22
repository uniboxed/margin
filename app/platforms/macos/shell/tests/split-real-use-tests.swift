// Split view as Tirth used it on the real screen, 2026-11-21 13:25–13:28 (fix/split-real-use), part of tests.swift's run:
// the library, the session, the real engine on the stand-in world (host-tests.swift `FakeHostWorld`, the real Mac's pacing:
// `staged`, tiles on) and a stand-in copy. Each check is the log's case:
// 1. a split opened from a Safari page: the new pane's window comes up in full screen in a Space of its own (Safari's,
//    as its key window was full screen) and macOS switches the display to it: never while the screen isn't frozen, its
//    Space taken by the early path; main keeps its rect and stays shown until the pane is in place, then both laid out;
// 2. a pane that can't fit (Safari's minimum known from its main window, before the pane's window exists): refused
//    before any window is made, out of the split, a toast; the minimum kept per app version in minimums.json;
// 3. a pane whose window never comes: out of the split, the rest laid out again; one left goes to the page area;
// 4. a new pane's window that its raise can't bring in front, side by side: nothing chased (they don't overlap), its keys;
// 5. a divider dragged between two windows, one slower than the other: each sent its frames on its own (none waiting);
// 6. the shell's engine forwards what the session asks of it (the drag's followers, showsAlone).
import AppKit
import Foundation

func splitRealUseTests() {
    splitRealUseSessionTests()
    splitRealUseMinimumTests()
    splitRealUseDragTests()
    splitRealUseGlueTests()
    splitRoomTests()
}

// Which panes leave a split laid out without room (HostedSession.noRoom), the real screen's numbers (2026-11-21 19:32:02):
// the page area 240,41 1264×933, Safari's least 574×220, Notes' 701×53.
private func splitRoomTests() {
    let page = CGRect(x: 240, y: 41, width: 1264, height: 933)
    let safari = CGSize(width: 574, height: 220), notes = CGSize(width: 701, height: 53)
    let past = HostedSession.noRoom([("s", .main, CGRect(x: 949, y: 41, width: 574, height: 933), safari), ("n", .pane, CGRect(x: 240, y: 41, width: 701, height: 933), notes)], page: page, had: [])
    check("split room: a pane past the page area (Safari's at 949…1523): the one coming in leaves (Notes), main never", past == ["n"], "\(String(describing: past))")
    let fits = HostedSession.noRoom([("s", .main, CGRect(x: 240, y: 41, width: 628, height: 933), safari), ("n", .pane, CGRect(x: 876, y: 41, width: 628, height: 933), CGSize(width: 560, height: 53))], page: page, had: [])
    check("split room: two at 628 within the page area, each above its least: nothing leaves", fits == nil, "\(String(describing: fits))")
    let under = HostedSession.noRoom([("s", .main, CGRect(x: 240, y: 41, width: 628, height: 933), safari), ("n", .pane, CGRect(x: 876, y: 41, width: 628, height: 933), notes)], page: page, had: ["s", "n"])
    check("split room: Notes' least grown to 701 in a split it was in (at 628): it leaves, main stays", under == ["n"], "\(String(describing: under))")
    let third = HostedSession.noRoom([("a", .main, CGRect(x: 240, y: 41, width: 416, height: 933), safari), ("b", .pane, CGRect(x: 664, y: 41, width: 416, height: 933), safari), ("c", .pane, CGRect(x: 1088, y: 41, width: 416, height: 933), safari)], page: page, had: ["a", "b"])
    check("split room: a third Safari pane squeezing all three under 574: only the newcomer leaves", third == ["c"], "\(String(describing: third))")
    let card = HostedSession.noRoom([("s", .main, page, safari), ("k", .card, CGRect(x: 0, y: 0, width: 3000, height: 3000), safari)], page: page, had: [])
    check("split room: the preview card isn't a pane (its own rect, never checked)", card == nil, "\(String(describing: card))")
    let edge = HostedSession.noRoom([("s", .main, CGRect(x: 239.5, y: 41, width: 628, height: 933), safari), ("n", .pane, CGRect(x: 876, y: 41, width: 628.6, height: 933), CGSize(width: 629, height: 53))], page: page, had: [])
    check("split room: within a point either way (rounding): fits", edge == nil, "\(String(describing: edge))")
    check("split room: the reasons that mean no room", HostedSession.isNoRoom(HostedSession.noRoomReason) && HostedSession.isNoRoom("its pane rect 1,2 3×4 is below its window's minimum 5×6") && HostedSession.isNoRoom("no room for it: its page area can't be reached from the display's (page …)") && !HostedSession.isNoRoom("main wasn't shown"))
}

// The session's world: a Safari web page shown alone, the split made from it (`createSplit`), then more panes.
private func splitRealUseSessionTests() {
    let echo = Diagnostics.echo
    var lines: [String] = []
    Diagnostics.echo = { lines.append($0) }
    defer { Diagnostics.echo = echo }
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let dataRoot = tempFolder("split-real-use")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: URL(fileURLWithPath: scriptPath), background: false) else {
        return check("split real use: the library opens (\(scriptPath): npm run build)", false)
    }
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "ru\(n)x" } }
    let w = FakeHostWorld()
    w.tilesOn = true
    w.staged = true
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
    engine.safariFocus = { await session.safariFocus($0, $1) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.hostedWindow = { session.hosted($0) }
    engine.hostedWindows = { session.hostedWindows($0) }
    engine.onMinimum = { session.minimum($0) }
    engine.onAppMinimums = { session.appMinimumsChanged() }
    engine.loading = { session.loading($0) }
    library.delegate = session
    var copyWindows: [Int: Int] = [:]
    var newUnraisable = false
    var noNewWindow = false // Safari never makes the window asked for
    var asks: [JSONObject] = []
    // Safari's new window: in full screen in a Space of its own when asked so, or (as the real one did, its key window full
    // screen in Margin's Space) whenever a window of it is full screen in Margin's Space already; else on the Desktop.
    links.onNewWindow = { id, payload in
        asks.append(payload)
        guard let pid = w.running(bundleId: "com.apple.Safari").first?.pid else { return }
        if noNewWindow { return }
        let n = w.nextWindow
        w.nextWindow += 1
        w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop])
        w.apps[pid]?.windows.append(n)
        let keyFull = w.wins.contains { $0.key != n && $0.value.pid == pid && $0.value.fullScreen && ($0.value.member || $0.value.tiled) && $0.value.spaces == [FakeHostWorld.marginSpace] }
        // (As the log has it: its Space and macOS's switch to it come while Safari is still making the window, which the
        // window server lists ~0.4 s after the ask: 13:26:01, `opened … 396 ms`.)
        if payload["fullscreen"] as? Bool == true || keyFull { w.bornFullScreen(n, switchAfter: 0.3); w.serverFrom[n] = w.clock + 0.4 }
        // (Made behind the others and unraisable from the split's set-up on: the real screen's, 2026-11-21 13:26:02.)
        if newUnraisable { w.raised.append(n); w.unraisable.insert(n) } else { w.raised.insert(n, at: 0) }
        copyWindows[id] = n
    }
    links.onSetWindowState = { id, on in
        guard let n = copyWindows[id], let pid = w.wins[n]?.pid else { return }
        w.applyFullScreen(pid: pid, window: n, on)
    }
    links.onCloseWindow = { id in if let n = copyWindows.removeValue(forKey: id) { w.closeWindow(n) } }
    var ratios: [CGFloat] = []
    window.splitShown = {
        guard let front = session.requested[1] ?? session.shown[1], let s = library.split(ofItem: front) else { return nil }
        return (s.id, s.panes, s.vertical, ratios.count == s.panes.count ? ratios : [])
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
    let pane2 = HostTarget.safariWindow("s-default", .pane(2)).id
    func win(_ id: HostID) -> Int { engine.hosts[id]?.window ?? -1 }
    func bounds(_ id: HostID) -> CGRect? { engine.hosts[id].flatMap { w.bounds(window: $0.window) } }
    func panes() -> [String: CGRect] { Dictionary(uniqueKeysWithValues: (window.paneLayout?.panes ?? []).map { ($0.item, $0.rect) }) }
    let page = window.hostedPlacement?.page ?? .zero
    check("split real use: set up: a web page shown alone in its profile's main window, a tile in Margin's Space at the page area",
          session.shown[1] == a && engine.visible.count == 1 && bounds(safari) == page && engine.hosts[safari]?.tile != nil && w.switchesSeen == 0,
          "\(String(describing: session.shown[1])) \(engine.visible) \(String(describing: bounds(safari))) \(page) \(w.switchesSeen)")

    // ---- 1. a split made from it: the pane's window born in full screen, macOS's switch never seen, main kept until it's in ----
    w.autoOnScreen = true
    w.byRaise = true
    w.moveFronts = true
    newUnraisable = true
    let mainWas = bounds(safari)
    var mainMovedEarly: [String] = []
    var paneInAt: Double?
    w.onClock = {
        let paneIn = engine.hosts[pane1].map { h in w.spaces(window: h.window) == [FakeHostWorld.marginSpace] && h.rect.map { w.bounds(window: h.window) == $0 } == true } ?? false
        if paneIn, paneInAt == nil { paneInAt = w.clock }
        // (Under the freeze nothing's seen: a tile coming into Margin's Space lays the first two out again for a moment.)
        if paneInAt == nil, !w.frozen, let now = bounds(safari), now != mainWas { mainMovedEarly.append("\(w.clock): main at \(now)") }
    }
    let switches = w.switchesSeen, freezes = w.frozenFor.count
    lines = []
    let t0 = w.clock
    run { _ = library.perform("createSplit", ["windowId": 1, "panes": [a, b]]) }
    let opened = w.clock - t0
    w.onClock = nil
    let rects = panes()
    let sp = library.split(ofItem: a)?.id ?? ""
    check("split real use 1: the pane's window asked in full screen (born in a Space of its own)",
          asks.last?["fullscreen"] as? Bool == true, "\(asks)")
    check("split real use 1: macOS's switch to the pane's new Space never shown (only ever under the freeze, undone)",
          w.switchesSeen == switches && w.current == FakeHostWorld.marginSpace, "\(w.switchesSeen - switches) switch(es) seen; \(lines.filter { $0.contains("pane1") && ($0.contains("full screen") || $0.contains("Space")) })")
    check("split real use 1: …its Space taken by the early path (\"full screen by the early path\", born in full screen), not the plain one",
          lines.contains { $0.contains("host: \(pane1): full screen by the early path") && $0.contains("born in full screen") }
          && !lines.contains { $0.contains("place \(pane1) attempt") }, "\(lines.filter { $0.contains(pane1.raw) }.prefix(8))")
    let frozen = Array(w.frozenFor.dropFirst(freezes))
    check("split real use 1: …under one freeze, from the window's ask until its Space was gone, no longer than the card's early path on the real screen (858 ms)",
          frozen.count == 1 && (frozen.first ?? 9) <= 0.86 && !w.frozen, "\(frozen.map { Int($0 * 1000) }) ms")
    check("split real use 1: main kept its rect and stayed shown until the new pane was in place (never shrunk with an empty box beside it)",
          mainMovedEarly.isEmpty && paneInAt != nil, "\(mainMovedEarly.prefix(3))")
    check("split real use 1: …then both at their <m-pane>s, the split shown, the pane focused",
          session.layout[1]?.split == sp && !sp.isEmpty && bounds(safari) == rects[a] && bounds(pane1) == rects[b] && engine.visible.count == 2 && engine.shown == pane1,
          "\(rects) \(String(describing: bounds(safari))) \(String(describing: bounds(pane1)))")
    check("split real use 1: …said as one change: main laid out again with the pane once it was in",
          lines.contains { $0.contains("host: layout: \(safari) laid out again with \(pane1)") }, "\(lines.filter { $0.contains("layout") })")
    // (Side by side the panes don't overlap: their order isn't chased, fix/pane-fronting. The move out and back for a
    // new window that overlaps another: pane-fronting-tests.swift's stacked case, screen-card-tests.swift's card.)
    let paneActivations = w.calls.filter { $0.hasPrefix("activate") }
    check("split real use 4: the pane's new window, unraisable, side by side: never moved out and back, never raised again, no copy asked; it has the keys",
          !lines.contains { $0.contains("host: \(pane1): out to a private Space and back") } && !lines.contains { $0.contains("\(pane1), focused, not in front") }
          && !links.asked.contains { $0.type == "hostFocusWindow" } && paneActivations.last?.hasSuffix(" \(win(pane1))") == true && engine.shown == pane1,
          "\(w.raised) \(paneActivations.suffix(3)) \(lines.filter { $0.contains("front") })")
    Diagnostics.echo = echo
    print("  (split real use: the split opened in \(Int(opened * 1000)) ms on the stand-in clock; frozen \(frozen.map { Int($0 * 1000) }) ms)")
    Diagnostics.echo = { lines.append($0) }

    // ---- 2. a third Safari pane that can't fit: Safari's minimum known (its tiles said it), refused before any window ----
    w.minSize["com.apple.Safari"] = CGSize(width: 574, height: 220)
    run { _ = engine.dragging(true); _ = engine.dragging(false) } // (a drag's start reads each tile's minimum once)
    check("split real use 2: Safari's minimum learnt from its windows' tiles, kept as Safari's (the page told it for every web pane)",
          engine.knownMinimum(of: .safariWindow("s-default", .pane(2))) == CGSize(width: 574, height: 220) && window.appMinimums["web"] == CGSize(width: 574, height: 220),
          "\(String(describing: engine.knownMinimum(of: .safariWindow("s-default", .pane(2))))) \(window.appMinimums)")
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://c.example/"]) }
    let c = item("https://c.example/")
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": b]) }
    ratios = [12, 12, 1] // (the page as it would lay them out squeezed: two at their 582, the third 48 wide)
    let mark = links.asked.count, pushes = window.pushed.count
    lines = []
    run { _ = library.perform("addToSplit", ["windowId": 1, "tabId": c, "splitId": sp]) }
    ratios = []
    let after = panes()
    check("split real use 2: a pane below Safari's known minimum: refused before anything is made for it (no window asked, none made)",
          !links.types(since: mark).contains("newWindow") && engine.hosts[pane2] == nil
          && (lines.contains { $0.contains("\(pane2)") && $0.contains("below its window's minimum 574×220") && $0.contains("none made") }
              || lines.contains { $0.contains("no room in the page area") && $0.contains("least 574×220") && $0.contains("nothing moved") }),
          "\(links.types(since: mark)) \(lines.filter { $0.contains("minimum") })")
    check("split real use 3: …out of the split at once (the page lays out the rest, never an empty box), said in a toast",
          library.split(sp)?.panes == [a, b] && window.pushed.dropFirst(pushes).contains { $0.contains(#""type":"toast""#) && $0.contains("Not enough room") },
          "\(String(describing: library.split(sp)?.panes)) \(window.pushed.dropFirst(pushes).filter { $0.contains("toast") })")
    check("split real use 3: …the two panes as they were, at their rects, the one with the keys keeping them",
          engine.visible.count == 2 && bounds(safari) == after[a] && bounds(pane1) == after[b] && session.shown[1] == b && session.layout[1]?.split == sp,
          "\(engine.visible) \(after) \(String(describing: bounds(safari))) pane1 \(String(describing: bounds(pane1))) \(String(describing: session.shown[1])) layout \(String(describing: session.layout[1]?.split)) \(lines.filter { $0.contains("layout") || $0.contains("room") }.suffix(12))")

    // ---- 3. a pane whose window never comes: out of the split; the one left at the page area ----
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://d.example/"]) }
    let d = item("https://d.example/")
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": a]) }
    run { _ = library.perform("removeFromSplit", ["windowId": 1, "tabId": b]) }
    check("split real use 3: (b out: a shown alone at the page area)", library.split(sp) == nil && engine.visible.count == 1 && bounds(safari) == page, "\(engine.visible) \(String(describing: bounds(safari)))")
    // (Its pane window closed as idle first: the pane's next open asks Safari for a new one, which never comes.)
    session.closeIdlePaneWindows()
    clock += 901
    run { session.closeIdlePaneWindows() }
    engine.options.windowWait = 0.5
    noNewWindow = true
    let pushes2 = window.pushed.count
    lines = []
    run { _ = library.perform("createSplit", ["windowId": 1, "panes": [a, d]]) }
    noNewWindow = false
    check("split real use 3: a pane whose window never came: out of the split (it ends at one), said; the one left alone at the page area, shown",
          library.split(ofItem: a) == nil && engine.visible.count == 1 && engine.shown == safari && bounds(safari) == page && engine.visible[safari]?.rect == nil
          && session.shown[1] == a && window.pushed.dropFirst(pushes2).contains { $0.contains("couldn't open in Split View") },
          "\(String(describing: library.split(ofItem: a))) \(engine.visible) \(String(describing: bounds(safari))) \(window.pushed.dropFirst(pushes2).filter { $0.contains("toast") }) \(lines.filter { $0.contains("pane1") || $0.contains("idle") || $0.contains("Safari window") || $0.contains("layout") }.suffix(14))")
    check("split real use 3: …main never left at a pane's rect meanwhile (it kept the page area: the pane never came in)",
          !lines.contains { $0.contains("host: \(safari): its tile sized to the page area") && !$0.contains(r(page)) }, "\(lines.filter { $0.contains("tile sized") })")

    // ---- 7. a pane laid out past the page area (the real screen, 2026-11-21 19:32:02: Notes' 701 beside a Safari tab's 574
    // in 1264 pt, Safari's pane at 949…1523): refused before any window moves, no full screen asked, the newcomer out of
    // the split and the person told, the item shown before kept at the page area ----
    window.paneRectsAs = { panes in panes.enumerated().map { i, p in i == 1 ? PagePane(item: p.item, rect: p.rect.offsetBy(dx: 30, dy: 0)) : p } }
    let mark7 = links.asked.count, pushes7 = window.pushed.count, spaces7 = w.nextId
    lines = []
    run { _ = library.perform("addToSplit", ["windowId": 1, "tabId": c]) }
    window.paneRectsAs = nil
    check("split real use 7: a pane past the page area: nothing asked of Safari (no window, no full screen), no Space made",
          !links.types(since: mark7).contains { $0 == "newWindow" || $0 == "setWindowState" } && w.nextId == spaces7,
          "\(links.types(since: mark7)) ids \(spaces7) → \(w.nextId)")
    check("split real use 7: …the newcomer out of the split, said in a toast; the log says why (each pane's rect and least)",
          library.split(ofItem: a) == nil && library.split(ofItem: c) == nil
          && window.pushed.dropFirst(pushes7).contains { $0.contains(#""type":"toast""#) && $0.contains("Not enough room") }
          && lines.contains { $0.contains("no room in the page area") && $0.contains("nothing moved") },
          "\(String(describing: library.split(ofItem: a))) \(window.pushed.dropFirst(pushes7).filter { $0.contains("toast") }) \(lines.filter { $0.contains("room") })")
    check("split real use 7: …the item shown before still shown alone at the page area, with the keys",
          engine.visible.count == 1 && engine.shown == safari && bounds(safari) == page && session.shown[1] == a,
          "\(engine.visible) \(String(describing: bounds(safari))) \(String(describing: session.shown[1]))")
    w.onClock = nil
}

private func r(_ rect: CGRect) -> String { "\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))×\(Int(rect.height))" }

// Each app's minimum kept per version beside routes.json, known at the next launch before any window of it is made.
private func splitRealUseMinimumTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-minimums-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let page = CGRect(x: 240, y: 41, width: 1264, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let notes = HostTarget.app("com.apple.Notes")
    let marker = folder.appendingPathComponent(HostMarker.fileName)
    let w = FakeHostWorld()
    w.tilesOn = true
    w.minSize["com.apple.Notes"] = CGSize(width: 700, height: 400)
    w.appVersions["com.apple.Notes"] = "4.12 (2700)"
    let e = HostEngine(system: w, marker: marker, pid: 1)
    e.options.privateRetire = 0
    e.options.earlyFullScreen = false
    _ = hostRun { await e.open(app: notes, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    let file = folder.appendingPathComponent("minimums.json")
    let saved = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject }
    check("split real use 2: an app's window's minimum, as its tile said it, kept in minimums.json beside routes.json with its version",
          (saved?["com.apple.Notes"] as? JSONObject)?["version"] as? String == "4.12 (2700)" && (saved?["com.apple.Notes"] as? JSONObject)?["width"] as? Double == 700,
          "\(String(describing: saved))")
    // The next launch: known before any window of it is made (its app not running, or the same version running).
    let w2 = FakeHostWorld()
    let e2 = HostEngine(system: w2, marker: marker, pid: 1)
    check("split real use 2: …known at the next launch before its app runs (a pane's room checked before its window exists)",
          e2.knownMinimum(of: notes) == CGSize(width: 700, height: 400) && e2.knownAppMinimums["com.apple.Notes"] == CGSize(width: 700, height: 400),
          "\(String(describing: e2.knownMinimum(of: notes)))")
    w2.appVersions["com.apple.Notes"] = "4.13 (2750)"
    w2.start("com.apple.Notes", policy: .regular, windows: 1)
    check("split real use 2: …and not for another version of it (learnt again from its window)", e2.knownMinimum(of: notes) == nil, "\(String(describing: e2.knownMinimum(of: notes)))")
    // The engine refuses a pane's rect below it before opening anything.
    let w3 = FakeHostWorld()
    w3.tilesOn = true
    let e3 = HostEngine(system: w3, marker: marker, pid: 1)
    e3.options.privateRetire = 0
    e3.options.earlyFullScreen = false
    _ = hostRun { await e3.open(app: .app("com.apple.TextEdit"), in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    let launches = w3.calls.filter { $0.hasPrefix("launch") }.count
    let left = CGRect(x: 240, y: 41, width: 800, height: 933), right = CGRect(x: 1048, y: 41, width: 456, height: 933)
    let res = hostRun { await e3.setLayout(main: .app("com.apple.TextEdit"), mainRect: left, extras: [HostExtra(target: notes, role: .pane, rect: right)], focused: nil, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) } ?? [:]
    var refused = false
    if case .failed? = res[notes.id] { refused = true }
    check("split real use 2: a pane's rect below its app's known minimum: refused before its app is started or a window made; the one left alone stays at the page area",
          refused && w3.calls.filter { $0.hasPrefix("launch") }.count == launches && e3.hosts[notes.id] == nil && e3.visible.count == 1
          && e3.visible[HostTarget.app("com.apple.TextEdit").id]?.rect == nil && w3.bounds(window: e3.hosts[HostTarget.app("com.apple.TextEdit").id]?.window ?? 0) == page,
          "\(res) \(e3.visible)")
}

// A divider dragged between two tiled windows, one slow to lay itself out (Safari's page) and one quick.
private func splitRealUseDragTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-split-drag-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let page = CGRect(x: 240, y: 41, width: 1264, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func rects(_ x: CGFloat) -> (CGRect, CGRect) {
        (CGRect(x: 240, y: 41, width: x - 240, height: 933), CGRect(x: x + 8, y: 41, width: 1504 - x - 8, height: 933))
    }
    func drag(quick: Double, slow: Double) -> (w: FakeHostWorld, e: HostEngine, quickTile: UInt64, slowTile: UInt64, frames: Int) {
        let w = FakeHostWorld()
        w.tilesOn = true
        let e = HostEngine(system: w, marker: folder.appendingPathComponent("\(UUID().uuidString)/\(HostMarker.fileName)"), pid: 1)
        e.options.privateRetire = 0
        e.options.earlyFullScreen = false
        _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let (l, rr) = rects(872)
        _ = hostRun { await e.setLayout(main: textEdit, mainRect: l, extras: [HostExtra(target: notes, role: .pane, rect: rr)], focused: nil, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let edit = e.hosts[textEdit.id]?.window ?? 0, nw = e.hosts[notes.id]?.window ?? 0
        w.tileLag[edit] = quick
        w.tileLag[nw] = slow
        _ = e.dragging(true)
        w.tileRectTimes = []
        // (The page's frames at 60 Hz for a second, the divider moving 4 pt each.)
        var frames = 0
        _ = hostRun {
            for i in 0..<60 {
                let (a, b) = rects(872 + CGFloat(i + 1) * 4)
                e.follow(placement, rects: [textEdit.id: a, notes.id: b])
                frames += 1
                await w.sleep(1.0 / 60)
            }
            await w.sleep(0.1)
            return true
        }
        _ = e.dragging(false)
        return (w, e, w.tileOf(edit) ?? 0, w.tileOf(nw) ?? 0, frames)
    }
    // One quick (4 ms), one slow (30 ms): the quick one never waits for the slow one.
    let (w, e, quick, slow, frames) = drag(quick: 0.004, slow: 0.030)
    let quickSent = w.tileRectTimes.filter { $0.tile == quick }.count, slowSent = w.tileRectTimes.filter { $0.tile == slow }.count
    let s = e.lastLive
    check("split real use 5: a divider's drag, one window quick and one slow: the quick one sent every frame of the page's (never waiting for the slow one), the slow one as it lands",
          quickSent >= frames - 2 && slowSent < quickSent && slowSent >= frames / 3, "\(frames) frames: quick \(quickSent) sent, slow \(slowSent) sent; \(s?.line ?? "")")
    let quickLanded = s?.perHost[textEdit.id]?.followed ?? []
    check("split real use 5: …the quick one's frames landing in its own time (median under 6 ms), the drag's numbers said per window",
          !quickLanded.isEmpty && (quickLanded.sorted()[quickLanded.count / 2]) <= 0.006 && (s?.line.contains("each: ") ?? false), s?.line ?? "")
    // Both alike: each frame's rects sent to both in the same tick (together), never one after the other's landing.
    let (w2, e2, q2, s2, frames2) = drag(quick: 0.008, slow: 0.008)
    let times2 = w2.tileRectTimes
    let ticks = Dictionary(grouping: times2, by: { $0.at }).values
    let both = ticks.filter { Set($0.map(\.tile)) == [q2, s2] }.count
    check("split real use 5: two windows alike: both sent each frame in the same tick (\(both) of \(ticks.count) ticks), every frame of the page's followed",
          both >= ticks.count - 2 && times2.filter { $0.tile == q2 }.count >= frames2 - 2, "\(both) of \(ticks.count); \(e2.lastLive?.line ?? "")")
    print("  (split real use 5, the stand-in: quick 4 ms + slow 30 ms: \(quickSent) and \(slowSent) of \(frames) frames sent; \(s?.line ?? "") | alike 8 ms: \(e2.lastLive?.line ?? ""))")
}

// The shell's engine (LateHostEngine) answers what the session asks as the engine does, never the stand-in's default.
private func splitRealUseGlueTests() {
    let page = CGRect(x: 240, y: 41, width: 1264, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let w = FakeHostWorld()
    w.tilesOn = true
    let e = HostEngine(system: w, marker: nil, pid: 1)
    e.options.privateRetire = 0
    e.options.earlyFullScreen = false
    let late = LateHostEngine { e }
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    _ = hostRun { await e.setLayout(main: textEdit, mainRect: CGRect(x: 240, y: 41, width: 628, height: 933), extras: [HostExtra(target: notes, role: .pane, rect: CGRect(x: 876, y: 41, width: 628, height: 933))], focused: nil, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    let followers = late.liveFollowers()
    check("split real use 6: the shell's engine: a split's two tiles counted as the drag's followers (the log said one: \"the hosted window follows it live\")",
          followers.follow == 2 && followers.visible == 2, "\(followers)")
    check("split real use 6: …and a show of main's profile's item laid out alone while a split is up (showsAlone false, never the stand-in's true)",
          late.showsAlone(textEdit.id) == false && e.showsAlone(textEdit.id) == false)
    check("split real use 6: the divider's drag line with two following", HostedSession.dragLine(divider: true, window: 1, following: true, followers) == "a split's divider dragged in Margin's window 1: 2 hosted windows follow it live")
}
