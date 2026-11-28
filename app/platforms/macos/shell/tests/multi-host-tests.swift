// Several visible hosts per Margin window (docs/PEEK-SPLIT.md §1), part of tests.swift's run: the host engine against
// the stand-in world (host-tests.swift `FakeHostWorld`, its tiles on and off) with a layout of two and three hosts at
// rects of their own: main and a split's pane, a card over them (a Safari window in the card's role, made by the
// stand-in for its profile's copy). With one visible host nothing changes: every older check is that.
import AppKit
import Foundation

func multiHostTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-multi-host-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    var made = 0
    func world(tiles: Bool = true) -> (FakeHostWorld, HostEngine) {
        made += 1
        let w = FakeHostWorld()
        w.tilesOn = tiles
        let e = HostEngine(system: w, marker: folder.appendingPathComponent("\(made)/\(HostMarker.fileName)"), pid: 1)
        e.options.privateRetire = 0
        e.options.earlyFullScreen = false
        return (w, e)
    }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    // A split's two panes in the page area (an 8 pt gap), and a card in the middle of it.
    let left = CGRect(x: 276, y: 41, width: 610, height: 933), right = CGRect(x: 894, y: 41, width: 610, height: 933)
    let card = CGRect(x: 374, y: 106, width: 1032, height: 803)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes"), faceTime = HostTarget.app("com.apple.FaceTime")
    func open(_ e: HostEngine, _ t: HostTarget) -> HostResult? {
        hostRun { await e.open(app: t, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func layout(_ e: HostEngine, _ main: HostTarget, _ mainRect: CGRect? = nil, _ extras: [HostExtra], focused: HostID? = nil) -> [HostID: HostResult] {
        hostRun { await e.setLayout(main: main, mainRect: mainRect, extras: extras, focused: focused, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) } ?? [:]
    }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func inMargin(_ w: FakeHostWorld, _ n: Int) -> Bool { w.spaces(window: n) == [FakeHostWorld.marginSpace] }
    func shown(_ r: HostResult?) -> Bool { if case .shown? = r { return true }; return false }
    // Polls with the clock moving (a quarter second each), each one's queued work waited for.
    func polls(_ w: FakeHostWorld, _ e: HostEngine, _ n: Int = 12) {
        for _ in 0..<n { w.clock += 0.25; e.poll(); _ = hostRun { await e.activateShown(at: nil); return true }; _ = hostRun { await w.sleep(0.001); return true } }
    }
    // The bridge's moves of a window into anything but Margin's Space since `mark` (a park of it).
    func parked(_ w: FakeHostWorld, _ n: Int, since mark: Int) -> Bool { w.calls.dropFirst(mark).contains { $0.hasPrefix("move \(n) ") && $0 != "move \(n) \(FakeHostWorld.marginSpace)" } }

    // ---- identity: a card's and a pane's ids, logged with their role; main's as before ----
    do {
        let main = HostTarget.safariWindow("Work").id, cardId = HostTarget.safariWindow("Work", .card).id, pane = HostTarget.safariWindow(nil, .pane(2)).id
        check("multi-host: main's id unchanged (safari:<profile>), a card's and a pane's with their role after it",
              main.raw == "safari:Work" && cardId.raw == "safari:Work#card" && pane.raw == "safari:#pane2" && HostTarget.safariWindow("Work", .main) == .safariWindow("Work"),
              "\(main.raw) \(cardId.raw) \(pane.raw)")
        check("multi-host: logged as safari:p<number>#card, never the profile's name; the default profile's as safari:default#pane2",
              cardId.description == main.description + "#card" && cardId.description.hasPrefix("safari:p") && !cardId.description.contains("Work") && pane.description == "safari:default#pane2",
              "\(cardId.description) \(pane.description)")
        check("multi-host: a card's role read back from its id, and its profile's main window (routes are its Safari's)",
              cardId.safariRole == .card && pane.safariRole == .pane(2) && main.safariRole == .main && cardId.main == main && pane.main == HostTarget.safariWindow(nil).id
              && HostID(raw: "app:com.apple.Notes").main.raw == "app:com.apple.Notes" && HostID(raw: "safari:odd#name").safariRole == .main, "\(cardId.main)")
    }

    // ---- Margin's window's side: the pointer's slot with several holes, the ground's cut-outs never overlapping ----
    do {
        let slot = Slot(rect: page, radius: 10, hits: [CGRect(x: 300, y: 50, width: 20, height: 20)], holes: [left, right])
        check("multi-host: the pointer through each pane's hole, not the gap between them, nor a hit over one",
              PassThrough.pageGets(CGPoint(x: 500, y: 500), slot) && PassThrough.pageGets(CGPoint(x: 1000, y: 500), slot) && !PassThrough.pageGets(CGPoint(x: 890, y: 500), slot)
              && !PassThrough.pageGets(CGPoint(x: 305, y: 55), slot) && PassThrough.pageGets(CGPoint(x: 500, y: 500), Slot(rect: page, radius: 10)))
        let cardOnly = Slot(rect: page, radius: 10, holes: [card])
        let region = CatchRegion.of(frame: FakeHostWorld.display, slot: cardOnly)
        check("multi-host: a card open: the pointer through its content only, the page around it caught (the catch fill there)",
              PassThrough.pageGets(CGPoint(x: card.midX, y: card.midY), cardOnly) && !PassThrough.pageGets(CGPoint(x: 300, y: 500), cardOnly)
              && region.contains(CGPoint(x: 300, y: 500 - 33), in: FakeHostWorld.display.size) && !region.contains(CGPoint(x: card.midX, y: card.midY - 33), in: FakeHostWorld.display.size),
              "\(region)")
        let r: [CGFloat] = [10, 0, 0, 10]
        let whole = MarginWindowController.groundHoles([(page, [10, 10, 10, 10]), (card, [])])
        let split = MarginWindowController.groundHoles([(left, r), (right, [0, 10, 10, 0]), (card, [])])
        let gapPiece = CGRect(x: left.maxX, y: card.minY, width: right.minX - left.maxX, height: card.height)
        check("multi-host: the ground's cut-outs: a card inside main's hole adds none; over two panes, only the gap between them, square (never an overlap filled again)",
              whole == [WindowGroundView.Hole(rect: page, radii: [10, 10, 10, 10])]
              && split == [WindowGroundView.Hole(rect: left, radii: r), WindowGroundView.Hole(rect: right, radii: [0, 10, 10, 0]), WindowGroundView.Hole(rect: gapPiece, radii: [])], "\(split)")
    }

    // ---- two visible hosts (tiles): main and a pane, each at its rect, held through polls ----
    do {
        let (w, e) = world()
        var told: [[HostShownWindow]] = []
        e.hostedWindows = { told.append($0) }
        _ = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        check("multi-host: one host opened: nothing said of several (the holes are today's one)", told.isEmpty && e.visible == [textEdit.id: HostVisible(rect: nil, role: .main, z: 0)], "\(told) \(e.visible)")
        let mark = w.calls.count
        let r = layout(e, textEdit, left, [HostExtra(target: notes, role: .pane, rect: right)])
        let n = window(w, "com.apple.Notes")
        check("multi-host: a split of two: both shown, main at its pane's rect, the other at its own, both in Margin's Space",
              shown(r[textEdit.id]) && shown(r[notes.id]) && w.bounds(window: edit) == left && w.bounds(window: n) == right && inMargin(w, edit) && inMargin(w, n),
              "\(r) \(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n)))")
        check("multi-host: …main never parked for the pane's first open (it comes in beside main, never in its place)", !parked(w, edit, since: mark), "\(w.calls.dropFirst(mark))")
        check("multi-host: …the layout held as it was asked: main focused, both visible, back to front",
              e.shown == textEdit.id && e.visible[textEdit.id]?.role == .main && e.visible[notes.id] == HostVisible(rect: right, role: .pane, z: 1) && e.shownWindow == edit,
              "\(e.visible) \(String(describing: e.shown))")
        check("multi-host: …Margin's window told both windows, each at its rect (its holes)",
              told.last == [HostShownWindow(window: edit, rect: left, role: .main, z: 0, focused: true, frame: left), HostShownWindow(window: n, rect: right, role: .pane, z: 1, focused: false, frame: right)], "\(told)")
        polls(w, e)
        check("multi-host: two visible hosts held at their rects through polls (desired keeps both: neither parked nor placed again)",
              w.bounds(window: edit) == left && w.bounds(window: n) == right && inMargin(w, edit) && inMargin(w, n) && e.hosts[notes.id]?.phase == .shown
              && e.hosts[textEdit.id]?.phase == .shown && e.visible.count == 2 && !parked(w, n, since: mark) && w.listsMarginOnly,
              "\(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n))) \(e.visible)")
        // A tile change Margin didn't make puts the pane off its rect: put back at its own rect, never the page area.
        if let t = w.tileOf(n) { w.tileRects[t] = CGRect(x: 0, y: 0, width: 750, height: 982) }
        polls(w, e)
        check("multi-host: a pane's tile laid out again by something else: sized back to its own rect (not the page area's), main left as it is",
              w.bounds(window: n) == right && w.bounds(window: edit) == left && inMargin(w, n), "\(String(describing: w.bounds(window: n)))")
        // A press in the pane: it's focused (the keys), main stays where it is.
        let focused = hostRun { await e.focus(notes.id) } ?? false
        check("multi-host: a pane focused: it's the one shown (the keys), fronted last; main still visible at its rect",
              focused && e.shown == notes.id && e.shownWindow == n && w.calls.last?.hasPrefix("activate") == true && w.calls.last?.hasSuffix(" \(n)") == true
              && w.bounds(window: edit) == left && inMargin(w, edit), "\(w.calls.suffix(3))")
        check("multi-host: the press's host found by its rect", e.visibleHost(at: CGPoint(x: 1000, y: 500)) == notes.id && e.visibleHost(at: CGPoint(x: 300, y: 500)) == textEdit.id
              && e.visibleHost(at: CGPoint(x: 100, y: 500)) == nil)

        // ---- live resize: every visible tile follows its rect in each frame of the drag ----
        let left2 = CGRect(x: 316, y: 41, width: 590, height: 933), right2 = CGRect(x: 914, y: 41, width: 590, height: 933)
        let on = e.dragging(true)
        var p2 = placement
        p2.page = CGRect(x: 316, y: 41, width: 1188, height: 933)
        e.follow(p2, rects: [textEdit.id: left2, notes.id: right2])
        _ = hostRun { await w.sleep(0.05); return true }
        let followedBoth = w.bounds(window: edit) == left2 && w.bounds(window: n) == right2
        _ = e.dragging(false)
        check("multi-host: a drag: both tiles follow their rects live (each one change in flight), Margin's Space told a live resize",
              on && followedBoth && w.liveResizing[FakeHostWorld.marginSpace] == false && w.calls.contains("liveResizing \(FakeHostWorld.marginSpace) true"),
              "\(on) \(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n)))")
        _ = hostRun { await e.pageRectChanged(p2, rects: [textEdit.id: left2, notes.id: right2]) }
        check("multi-host: the drag's end: each at its rect as Margin's from now", w.bounds(window: edit) == left2 && w.bounds(window: n) == right2 && e.visible[notes.id]?.rect == right2,
              "\(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n)))")

        // ---- three visible: a window-mode app as a card over the split ----
        let mark3 = w.calls.count
        let r3 = layout(e, textEdit, left2, [HostExtra(target: notes, role: .pane, rect: right2), HostExtra(target: faceTime, role: .card, rect: card)], focused: faceTime.id)
        let ft = window(w, "com.apple.FaceTime")
        check("multi-host: three visible: a card (window mode) over two panes, each at its rect, the card focused",
              shown(r3[faceTime.id]) && w.bounds(window: ft) == card && inMargin(w, ft) && w.bounds(window: edit) == left2 && w.bounds(window: n) == right2 && inMargin(w, edit) && inMargin(w, n)
              && e.shown == faceTime.id && e.visible.count == 3, "\(r3) \(String(describing: w.bounds(window: ft)))")
        check("multi-host: …a card never parks main or a pane", !parked(w, edit, since: mark3) && !parked(w, n, since: mark3), "\(w.calls.dropFirst(mark3))")
        polls(w, e)
        check("multi-host: three visible hosts held at their rects through polls", w.bounds(window: ft) == card && w.bounds(window: edit) == left2 && w.bounds(window: n) == right2
              && inMargin(w, ft) && inMargin(w, edit) && inMargin(w, n) && e.visible.count == 3 && e.shown == faceTime.id, "\(e.visible) \(String(describing: e.shown))")
        let refused = hostRun { await e.focus(notes.id) } ?? true
        check("multi-host: a card open keeps the focus: a pane isn't focused over it (never main raised over the card)", !refused && e.shown == faceTime.id)

        // ---- the card closed: it alone parked, the others left as they are ----
        let mark4 = w.calls.count
        let r4 = layout(e, textEdit, left2, [HostExtra(target: notes, role: .pane, rect: right2)])
        check("multi-host: a park of one (the card) leaves the others where they are, main focused again",
              shown(r4[textEdit.id]) && w.spaces(window: ft) == [] && e.hosts[faceTime.id]?.phase == .parked && inMargin(w, edit) && inMargin(w, n)
              && w.bounds(window: edit) == left2 && w.bounds(window: n) == right2 && !parked(w, edit, since: mark4) && !parked(w, n, since: mark4) && e.shown == textEdit.id && e.visible.count == 2,
              "\(r4) \(e.visible) \(w.calls.dropFirst(mark4))")

        // ---- the split left: main alone at the page area, the pane parked, one host again ----
        told = []
        let back = open(e, textEdit)
        check("multi-host: back to one: main at the page area, the pane parked, Margin's window told [] once (one hole again)",
              back == .shown(textEdit.id, placed: true) && w.bounds(window: edit) == page && w.spaces(window: n) == [] && e.visible == [textEdit.id: HostVisible(rect: nil, role: .main, z: 0)]
              && told == [[]] && e.hosts[textEdit.id]?.rect == nil, "\(String(describing: back)) \(String(describing: w.bounds(window: edit))) \(told) \(e.visible)")
        let mark5 = w.calls.count
        told = []
        check("multi-host: …and then today's switch, nothing said of several", open(e, notes) == .shown(notes.id, placed: true) && w.bounds(window: n) == page && w.spaces(window: edit) == [] && told.isEmpty,
              "\(w.calls.dropFirst(mark5)) \(told)")
        check("multi-host: nothing left behind (Mission Control lists Margin's Space only)", w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && !w.frozen)
    }

    // ---- a card (Safari's window in the card's role) over an app: main never parked, the stray rule leaves it alone ----
    do {
        let (w, e) = world()
        w.toolbarAbove = ["com.apple.Safari"] // (its full-screen windows' toolbar a window of its own, resting above each)
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        var roles: [String] = []
        e.requestRoleWindow = { p, role in roles.append("\(p ?? "default") \(role)"); return copy.request(p) }
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        let peek = HostTarget.safariWindow(nil, .card)
        let mark = w.calls.count
        let r = layout(e, textEdit, nil, [HostExtra(target: peek, role: .card, rect: card)], focused: peek.id)
        let cw = e.hosts[peek.id]?.window ?? 0
        check("multi-host: a card's first open: its window asked of the copy in the card's role, never the main one's ask",
              roles == ["default card"] && copy.asked == [nil] && shown(r[peek.id]) && e.hosts[peek.id]?.safariWindow != nil, "\(roles) \(copy.asked) \(r)")
        check("multi-host: …at its rect in Margin's Space, focused; main at the page area, never parked for it",
              w.bounds(window: cw) == card && inMargin(w, cw) && e.shown == peek.id && w.bounds(window: edit) == page && inMargin(w, edit) && !parked(w, edit, since: mark),
              "\(String(describing: w.bounds(window: cw))) \(w.calls.dropFirst(mark))")
        polls(w, e, 16)
        let parkedCard = events.contains { if case .parked(peek.id) = $0 { return true }; if case .unshown(peek.id) = $0 { return true }; return false }
        check("multi-host: the stray rule leaves a visible card's window alone through polls (in Margin's Space, shown: no stray, no park)",
              inMargin(w, cw) && w.bounds(window: cw) == card && e.hosts[peek.id]?.phase == .shown && !parkedCard && inMargin(w, edit) && e.shown == peek.id,
              "\(events) \(String(describing: w.spaces(window: cw)))")
        // The card's own full-screen toolbar (Safari's, resting above its window: as wide as the card, not the page area):
        // the engine tells the observer the card's rect for its app, and the core reads such a window as its strip
        // (kinds.rs `is_strip_of_any`; against the page area alone it was a small, transient window); never moved or parked.
        let toolbar = w.toolbarOf[cw] ?? 0
        let toolbarMark = w.calls.count
        polls(w, e, 8)
        let facts = e.observed().first { $0.pid == safariPid }
        let tb = w.bounds(window: toolbar) ?? .zero
        let one = [WindowKinds.Window(number: toolbar, bounds: tb, onScreen: true, place: .margin, everPlaced: true)]
        let asStrip = WindowKinds.classify(one, app: WindowKinds.App(launchedByMargin: true, hosted: [cw], hostRects: facts?.hostRects ?? []), in: placement)[toolbar]?.kind
        let alone = WindowKinds.classify(one, app: WindowKinds.App(launchedByMargin: true, hosted: [cw]), in: placement)[toolbar]?.kind
        check("multi-host: a card's own toolbar is a strip of the card's rect (the engine gives its app the card's rect), never a small window; never moved or parked",
              toolbar != 0 && facts?.hostRects == [card] && tb.width == card.width && tb.height < 100 && asStrip == .strip && alone == .transient
              && WindowKinds.isStrip(tb, in: placement, rects: [card]) && !WindowKinds.isStrip(tb, in: placement)
              && !w.calls.dropFirst(toolbarMark).contains { $0.hasPrefix("move \(toolbar) ") } && w.spaces(window: toolbar) == w.spaces(window: cw),
              "\(toolbar) \(String(describing: facts?.hostRects)) \(tb) \(String(describing: asStrip)) \(String(describing: alone)) \(w.calls.dropFirst(toolbarMark).filter { $0.hasPrefix("move") })")
        // Margin's window leaving full screen: every visible host parked, nothing left in a user Space.
        _ = hostRun { await e.parkShown(why: "test") }
        check("multi-host: parked with nothing shown: the card and main both out of Margin's Space", w.spaces(window: cw) == [] && w.spaces(window: edit) == [] && e.shown == nil && e.visible.isEmpty,
              "\(String(describing: w.spaces(window: cw))) \(String(describing: w.spaces(window: edit))) \(e.visible)")
    }

    // ---- Margin crashed with a card and a Safari main window shown: the next launch gives both back (closed by their copy) ----
    do {
        let (w, e) = world()
        let markerURL = folder.appendingPathComponent("\(made)/\(HostMarker.fileName)")
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        e.requestRoleWindow = { p, _ in copy.request(p) }
        _ = open(e, .safariWindow("Work"))
        let peek = HostTarget.safariWindow("Work", .card)
        let r = layout(e, .safariWindow("Work"), nil, [HostExtra(target: peek, role: .card, rect: card)], focused: peek.id)
        let mainWindow = e.hosts[HostTarget.safariWindow("Work").id]?.window ?? 0, cardWindow = e.hosts[peek.id]?.window ?? 0
        let m = HostMarker.read(markerURL)
        check("multi-host: the marker has both of the profile's windows (main's and the card's), each with its copy's id and its profile",
              shown(r[peek.id]) && Set(m?.windows.map(\.number) ?? []) == [mainWindow, cardWindow] && Set(m?.windows.compactMap(\.safariWindow) ?? []) == [7914, 7915]
              && m?.windows.allSatisfy { $0.profile == "Work" } == true, "\(String(describing: m))")
        w.onAppQuit = nil
        let next = HostEngine(system: w, marker: markerURL, pid: 2)
        let later = FakeSafariCopy(w) { safariPid }
        later.windowOf = copy.windowOf
        later.wire(next)
        hostRun { await next.recover() }
        check("multi-host: recovery: both windows given back and closed by their copy, the marker gone, Safari left running",
              w.wins[mainWindow] == nil && w.wins[cardWindow] == nil && Set(later.closed) == [7914, 7915] && !FileManager.default.fileExists(atPath: markerURL.path) && w.apps[safariPid] != nil,
              "\(later.closed) \(next.leftSafariWindows)")
    }

    // ---- a pane below its window's minimum: shown cut (docs/PEEK-SPLIT.md §4b), its window at its own minimum, the rest
    // away from the other panes (past the display's edge for the pane at the page's end), never sent narrower (no tile
    // below its minimum: macOS takes such a window out of its tile) ----
    do {
        let (w, e) = world()
        w.minSize["com.apple.Notes"] = CGSize(width: 700, height: 400)
        _ = open(e, notes)
        _ = open(e, textEdit)
        let n = window(w, "com.apple.Notes")
        let r = layout(e, textEdit, left, [HostExtra(target: notes, role: .pane, rect: right)])
        let shown: Bool = { if case .shown? = r[notes.id] { return true }; return false }()
        let b = w.bounds(window: n) ?? .zero
        let want = HostLayout.cut(right, min: CGSize(width: 700, height: 400), in: FakeHostWorld.display, page: page, endX: nil, endY: nil)
        check("multi-host: a pane narrower than its window's minimum: shown cut, its window at its minimum, its start at its pane's and the rest past the display's edge (894…1594), never below it",
              shown && b == want && b == CGRect(x: 894, y: 41, width: 700, height: 933) && w.belowMinimum == 0 && e.visible[notes.id]?.rect == right,
              "\(r) \(b) want \(want)")
    }

    // ---- a cut pane (docs/PEEK-SPLIT.md §4b): under no pane at the page's end (past the display's edge), kept behind a
    // pane while it lies under it (the middle of three) ----
    do {
        let (w, e) = world()
        w.byRaise = true // (the window server's order: the raise order)
        w.minSize["com.apple.Notes"] = CGSize(width: 700, height: 400)
        let maps = HostTarget.app("com.apple.Maps") // (a third app that goes full screen in the stand-in; no minimum: never cut)
        w.installed.insert("com.apple.Maps")
        var told: [[HostShownWindow]] = []
        e.hostedWindows = { told.append($0) }
        _ = open(e, notes)
        _ = open(e, maps)
        _ = open(e, textEdit)
        let n = window(w, "com.apple.Notes"), edit = window(w, "com.apple.TextEdit")
        _ = layout(e, textEdit, left, [HostExtra(target: notes, role: .pane, rect: right)])
        let h = e.hosts[notes.id]
        let start = CGRect(x: 894, y: 41, width: 700, height: 933)
        check("cut pane: at the page's end: cut, its rest past the display's edge",
              h.map { e.isCut($0) } == true && w.bounds(window: n) == start, "\(String(describing: w.bounds(window: n)))")
        let first = told.last?.first { $0.window == n }
        check("cut pane: …told with its pane the hole, its window's frame apart, under no pane (not tucked), cut",
              first?.rect == right && first?.frame == start && first?.tucked == false && first?.cut == true, "\(String(describing: first))")
        let calls0 = w.activeCalls.count
        _ = hostRun { await e.focus(notes.id, fronted: false) }
        check("cut pane: under no pane, focused: as any pane (no focus without a raise)",
              e.shown == notes.id && !w.activeCalls.dropFirst(calls0).contains { $0.hasPrefix("focusWithoutRaise ") }, "\(w.activeCalls.dropFirst(calls0))")
        // (Under no pane: the poll has nothing to look at, whatever the order.)
        w.autoOnScreen = true
        func pollOnly(_ k: Int) { for _ in 0..<k { w.clock += 0.25; e.poll(); _ = hostRun { await w.sleep(0.001); return true }; _ = hostRun { await w.sleep(0.001); return true } } }
        let callsP = w.calls.count
        pollOnly(2)
        check("cut pane: under no pane: the poll puts nothing back", !w.calls.dropFirst(callsP).contains { $0.hasPrefix("activate ") }, "\(w.calls.dropFirst(callsP))")
        _ = hostRun { await e.focus(textEdit.id, fronted: true) }
        // The middle of three: its rest under the first pane (392…1092), tucked, ordered behind it.
        let a = CGRect(x: 276, y: 41, width: 404, height: 933), b = CGRect(x: 688, y: 41, width: 404, height: 933), c = CGRect(x: 1100, y: 41, width: 404, height: 933)
        _ = layout(e, textEdit, a, [HostExtra(target: notes, role: .pane, rect: b), HostExtra(target: maps, role: .pane, rect: c)])
        let under = CGRect(x: 392, y: 41, width: 700, height: 933)
        let second = told.last?.first { $0.window == n }
        check("cut pane: the middle of three: its window's rest under the first pane (392…1092), told tucked, ordered behind it",
              w.bounds(window: n) == under && second?.tucked == true && second?.cut == true && w.inFront(n, of: edit) == false,
              "\(String(describing: w.bounds(window: n))) \(String(describing: second)) \(w.raised)")
        let calls1 = w.activeCalls.count
        _ = hostRun { await e.focus(notes.id, fronted: false) }
        check("cut pane: under the left pane, focused: its app given the keys without a raise, never made front by a raising call",
              w.activeCalls.dropFirst(calls1).contains { $0.hasPrefix("focusWithoutRaise ") && $0.hasSuffix(" \(n)") } && !w.activeCalls.dropFirst(calls1).contains { $0.hasPrefix("makeFront ") && $0.hasSuffix(" \(n)") }
              && w.inFront(n, of: edit) == false, "\(w.activeCalls.dropFirst(calls1)) \(w.raised)")
        // Its app brought in front some other way (⌘-Tab): macOS raised its window over the left pane; put back under it.
        w.raised.removeAll { $0 == n }
        w.raised.insert(n, at: 0)
        let calls2 = w.activeCalls.count
        let notesPid = h?.pid ?? 0
        let repaired = hostRun { await e.repairCutOrder(notesPid) } ?? false
        let ei = w.raised.firstIndex(of: edit) ?? 99, ni = w.raised.firstIndex(of: n) ?? -1
        check("cut pane: its app brought in front by ⌘-Tab (its window raised over the left pane): the left pane over it again, its keys without a raise",
              repaired && ei < ni && w.activeCalls.dropFirst(calls2).contains { $0.hasPrefix("focusWithoutRaise ") && $0.hasSuffix(" \(n)") }, "\(repaired) \(w.raised) \(w.activeCalls.dropFirst(calls2)) on screen \(w.onScreenWindows()?.map(\.number) ?? [])")
        let calls3 = w.activeCalls.count
        let again = hostRun { await e.repairCutOrder(notesPid) } ?? true
        check("cut pane: …its app in front again with its window already behind: nothing done", !again && w.activeCalls.count == calls3, "\(w.activeCalls.dropFirst(calls3))")
        // Its window raised with no app activated (the app ordering it front itself, an Accessibility raise): no event,
        // the poll finds it over the left pane in the on-screen list it reads, and puts it back.
        w.raised.removeAll { $0 == n }
        w.raised.insert(n, at: 0)
        let calls4 = w.activeCalls.count
        pollOnly(1)
        let ei4 = w.raised.firstIndex(of: edit) ?? 99, ni4 = w.raised.firstIndex(of: n) ?? -1
        check("cut pane: its window raised over the left pane with no activation: the next poll puts it back under, its keys without a raise",
              ei4 < ni4 && w.activeCalls.dropFirst(calls4).contains { $0.hasPrefix("focusWithoutRaise ") && $0.hasSuffix(" \(n)") }, "\(w.raised) \(w.activeCalls.dropFirst(calls4))")
        let calls5 = w.activeCalls.count
        pollOnly(2)
        check("cut pane: …later polls with it behind: nothing done", w.activeCalls.count == calls5, "\(w.activeCalls.dropFirst(calls5))")
        // Its neighbour's raise never taking: 3 tries, said once, then left as it is for good (never 3 tries every 5 s),
        // until its window is seen behind again.
        w.clock += 6
        w.unraisable.insert(edit)
        w.raised.removeAll { $0 == n }
        w.raised.insert(n, at: 0)
        let editPid = w.wins[edit]?.pid ?? 0
        func tries() -> Int { w.calls.filter { $0 == "activate \(editPid) \(edit)" }.count }
        let tries0 = tries()
        pollOnly(6)
        let firstRound = tries() - tries0
        w.clock += 6
        pollOnly(6)
        check("cut pane: its neighbour's raise never taking: 3 tries, then left as it is, not tried again 5 s later",
              firstRound == 3 && tries() - tries0 == 3, "\(firstRound) \(tries() - tries0)")
        w.unraisable.remove(edit)
        w.raised.removeAll { $0 == edit }
        w.raised.insert(edit, at: 0)
        pollOnly(1)
        w.raised.removeAll { $0 == n }
        w.raised.insert(n, at: 0)
        let tries2 = tries()
        pollOnly(1)
        check("cut pane: …its window seen behind again, then over again: put back again", tries() > tries2 && (w.raised.firstIndex(of: edit) ?? 99) < (w.raised.firstIndex(of: n) ?? -1), "\(tries() - tries2) \(w.raised)")
        // Two panes again, it at the page's end: its rest past the display's edge again, under no pane.
        _ = layout(e, textEdit, left, [HostExtra(target: notes, role: .pane, rect: right)])
        let third = told.last?.first { $0.window == n }
        check("cut pane: at the page's end again: its window's start at its pane's (past the display's edge), under no pane",
              w.bounds(window: n) == start && third?.cut == true && third?.tucked == false, "\(String(describing: w.bounds(window: n))) \(String(describing: third))")
        // A new layout (a divider moved): the pane's new rect, away from the other panes.
        let narrower = CGRect(x: 914, y: 41, width: 590, height: 933)
        _ = layout(e, textEdit, CGRect(x: 276, y: 41, width: 630, height: 933), [HostExtra(target: notes, role: .pane, rect: narrower)])
        check("cut pane: its pane's rect changed (a divider moved): away from the other panes again, past the display's edge",
              w.bounds(window: n) == CGRect(x: 914, y: 41, width: 700, height: 933), "\(String(describing: w.bounds(window: n)))")
    }

    // ---- three panes, two cut: the middle one's rest under the pane before it, the last one's past the display's edge,
    // each kept behind the ones it lies under (a chain) ----
    do {
        let (w, e) = world()
        w.byRaise = true
        w.minSize["com.apple.Notes"] = CGSize(width: 700, height: 400)
        let maps = HostTarget.app("com.apple.Maps") // (a third app that goes full screen in the stand-in)
        w.installed.insert("com.apple.Maps")
        w.minSize["com.apple.Maps"] = CGSize(width: 600, height: 400)
        _ = open(e, notes)
        _ = open(e, maps)
        _ = open(e, textEdit)
        let n = window(w, "com.apple.Notes"), f = window(w, "com.apple.Maps"), edit = window(w, "com.apple.TextEdit")
        let a = CGRect(x: 276, y: 41, width: 404, height: 933), b = CGRect(x: 688, y: 41, width: 404, height: 933), c = CGRect(x: 1100, y: 41, width: 404, height: 933)
        _ = layout(e, textEdit, a, [HostExtra(target: notes, role: .pane, rect: b), HostExtra(target: maps, role: .pane, rect: c)])
        let hn = e.hosts[notes.id], hf = e.hosts[maps.id]
        check("three panes: the middle one's rest under the first (392…1092), the last one's past the display's edge (1100…1700); the middle one behind the first",
              w.bounds(window: n) == CGRect(x: 392, y: 41, width: 700, height: 933) && w.bounds(window: f) == CGRect(x: 1100, y: 41, width: 600, height: 933)
              && hn.map { e.isCut($0) } == true && hf.map { e.isCut($0) } == true && w.inFront(n, of: edit) == false,
              "\(String(describing: w.bounds(window: n))) \(String(describing: w.bounds(window: f))) \(w.raised)")
        _ = hostRun { await e.focus(notes.id, fronted: false) }
        check("three panes: the middle one focused: still behind the first", w.inFront(n, of: edit) == false, "\(w.raised)")
    }

    // ---- tiles off: a pane as a plain member, placed at its rect by its own Space's reservation ----
    do {
        let (w, e) = world(tiles: false)
        _ = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        let mark = w.calls.count
        let r = layout(e, textEdit, nil, [HostExtra(target: notes, role: .card, rect: card)], focused: notes.id)
        let n = window(w, "com.apple.Notes")
        check("multi-host: tiles off: a card's first open as a member at its rect, main at the page area, never parked",
              shown(r[notes.id]) && w.bounds(window: n) == card && inMargin(w, n) && w.bounds(window: edit) == page && inMargin(w, edit) && !parked(w, edit, since: mark) && e.shown == notes.id,
              "\(r) \(String(describing: w.bounds(window: n)))")
        polls(w, e)
        check("multi-host: tiles off: both held through polls", w.bounds(window: n) == card && inMargin(w, n) && w.bounds(window: edit) == page && inMargin(w, edit) && e.visible.count == 2,
              "\(String(describing: w.bounds(window: n))) \(e.visible)")
        // The window under the card (visible, not focused) moved off its place by something else: put back at its rect by
        // the reconciler, as the focused one would be. (Fails if `desired` keeps only the focused host shown: the one
        // under a card is then "parked" to it, and nothing puts it back.)
        w.wins[edit]?.memberFrame = CGRect(x: 300, y: 60, width: 900, height: 700)
        polls(w, e, 16)
        check("multi-host: desired keeps every visible host shown: the window under a card, moved off its place, is put back at the page area, the card left at its rect and focused",
              w.bounds(window: edit) == page && inMargin(w, edit) && w.bounds(window: n) == card && inMargin(w, n) && e.shown == notes.id && e.visible.count == 2,
              "\(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n))) \(e.visible)")
    }
}
