// The hosting core's stage 2 (docs/HOSTING-CORE.md): the window kinds (WindowKinds.swift), a row per case the real
// sessions showed (2026-11-17 07:52, 14:05, 15:19: Safari's restored windows, Maps restored in full screen, the Phone's
// dialog-subrole window, Messages' twin, Mail's strip and settings window, sheets, menus and tooltips), the model's log
// lines (HostModel.swift), and the observer (HostObserver.swift) on the stand-in window manager (host-tests.swift
// FakeHostWorld, unchanged: Accessibility's side is this file's FakeObservation). Part of tests.swift's run.
import AppKit
import Foundation

// Accessibility for the observer, played from the stand-in's windows: their role and subrole (`axRole`, a standard
// window's when none), full screen, minimized; the app's main and focused windows only as a test sets them (`main`,
// `focused`); only the current Space's windows when the stand-in says so (`axCurrentOnly`). Never touches what the
// engine's Accessibility reads (no `axSeen`). `post` plays a notification.
final class FakeObservation: HostObservation {
    let world: FakeHostWorld
    var watched: [pid_t: (HostAXNote, Int?) -> Void] = [:]
    var unwatched: [pid_t] = []
    var reads: [(pid: pid_t, windows: [Int])] = []
    init(_ world: FakeHostWorld) { self.world = world }
    func watch(pid: pid_t, _ heard: @escaping (HostAXNote, Int?) -> Void) -> Bool { watched[pid] = heard; return true }
    func unwatch(pid: pid_t) { watched[pid] = nil; unwatched.append(pid) }
    func read(pid: pid_t, windows: [Int]) async -> HostAXRead? {
        reads.append((pid, windows))
        guard world.apps[pid] != nil else { return nil }
        var out = HostAXRead(main: world.main[pid], focused: world.focused[pid])
        for n in windows {
            guard let w = world.wins[n], w.pid == pid, !world.axCurrentOnly || world.onCurrent(n) else { continue }
            let parts = (w.axRole ?? "AXWindow/AXStandardWindow").split(separator: "/").map(String.init)
            out.windows[n] = HostAXWindow(role: parts.first, subrole: parts.count > 1 ? parts[1] : nil, fullScreen: w.fullScreen, canFullScreen: w.canFullScreen,
                                          resizable: w.resizable, minimized: w.minimized)
        }
        return out
    }
    func post(_ pid: pid_t, _ note: HostAXNote, _ window: Int?) { watched[pid]?(note, window) }
}

func hostModelTests() {
    windowKindsTests()
    hostModelLineTests()
    hostObserverTests()
}

// ---- the kinds: one row per real case ----

func windowKindsTests() {
    typealias W = WindowKinds.Window
    // His display (15:19): the full-screen area and the page area beside a 260 pt sidebar.
    let area = CGRect(x: 0, y: 33, width: 1512, height: 949), page = CGRect(x: 260, y: 41, width: 1244, height: 933)
    let placement = HostPlacement(page: page, area: area)
    let desk = CGRect(x: 100, y: 100, width: 1200, height: 800)
    func std(_ n: Int, _ b: CGRect, _ place: WindowPlace, onScreen: Bool? = nil, full: Bool? = true) -> W {
        W(number: n, bounds: b, onScreen: onScreen, place: place, everPlaced: place.placed, role: "AXWindow", subrole: "AXStandardWindow", canFullScreen: full)
    }
    func unread(_ n: Int, _ b: CGRect, _ place: WindowPlace, onScreen: Bool? = nil) -> W { W(number: n, bounds: b, onScreen: onScreen, place: place, everPlaced: place.placed) }
    struct Row { let name: String; let windows: [W]; let app: WindowKinds.App; let want: [Int: WindowKind]; var why: [Int: String] = [:] }
    let rows: [Row] = [
        // Safari, 15:19: a Safari Margin started restored two windows into full-screen Spaces of their own and one on
        // the Desktop (Accessibility lists none: not the current Space), then made the one Margin asked for (71157).
        Row(name: "Safari Margin started: its two restored full-screen windows and its Desktop window are leftovers, the one Margin asked for is main",
            windows: [unread(71150, area, .fullScreen), unread(71151, area, .fullScreen), unread(71152, desk, .desktop), std(71157, page, .parked)],
            app: .init(launchedByMargin: true, hosted: [71157]), want: [71150: .leftover, 71151: .leftover, 71152: .leftover, 71157: .main],
            why: [71150: "restored", 71157: "the window Margin hosts"]),
        Row(name: "Safari the person opened: their own windows are auxiliary (never leftovers), the one Margin asked for main",
            windows: [unread(71150, area, .fullScreen), unread(71152, desk, .desktop, onScreen: true), std(71157, page, .margin, onScreen: true)],
            app: .init(launchedByMargin: false, hosted: [71157]), want: [71150: .auxiliary, 71152: .auxiliary, 71157: .main], why: [71152: "the person opened"]),
        // Maps, 07:52: its window restored already in full screen, in a Space the Dock made for it, its app hidden.
        Row(name: "Maps' window restored in full screen in a Space of its own, hosted: main",
            windows: [unread(1563, area, .fullScreen)], app: .init(launchedByMargin: true, hosted: [1563]), want: [1563: .main]),
        Row(name: "...and before Margin hosts it (the first look at a Maps Margin started): its only window, main",
            windows: [unread(1563, area, .fullScreen)], app: .init(launchedByMargin: true), want: [1563: .main], why: [1563: "only window"]),
        // Phone, 15:21: its only window, AXWindow/AXDialog 1024×768, in Margin's Space and off screen.
        Row(name: "the Phone's only window, a dialog-subrole one 1024×768 (in Margin's Space, off screen): main",
            windows: [W(number: 71265, bounds: CGRect(x: 370, y: 124, width: 1024, height: 768), onScreen: false, place: .margin, everPlaced: true, role: "AXWindow", subrole: "AXDialog", canFullScreen: false)],
            app: .init(launchedByMargin: true, hosted: [71265]), want: [71265: .main], why: [71265: "dialog-subrole"]),
        Row(name: "...not hosted yet, the same window: still main (no other window could be)",
            windows: [W(number: 71265, bounds: CGRect(x: 370, y: 124, width: 1024, height: 768), place: .desktop, everPlaced: true, role: "AXWindow", subrole: "AXDialog", canFullScreen: false)],
            app: .init(launchedByMargin: true), want: [71265: .main]),
        // Dictionary, 2026-11-15: three spares of the real window's size and a 500×500 one, never ordered in.
        Row(name: "Dictionary's spares (dialog-subrole, never ordered in) are transient, its real window main",
            windows: [W(number: 10, bounds: CGRect(x: 110, y: 60, width: 1292, height: 888), place: .nowhere, role: "AXWindow", subrole: "AXDialog"),
                      W(number: 11, bounds: CGRect(x: 110, y: 60, width: 1292, height: 888), place: .nowhere, role: "AXWindow", subrole: "AXDialog"),
                      W(number: 12, bounds: CGRect(x: 110, y: 60, width: 500, height: 500), place: .nowhere),
                      W(number: 13, bounds: CGRect(x: 110, y: 60, width: 1292, height: 888), onScreen: true, place: .desktop, everPlaced: true, role: "AXWindow", subrole: "AXDialog")],
            app: .init(launchedByMargin: true, hosted: [13]), want: [10: .transient, 11: .transient, 12: .transient, 13: .main], why: [10: "a spare"]),
        // Messages, 15:20: its hosted window (71192) left every Space every few seconds; a second window at its frame.
        Row(name: "Messages' twin, both in Margin's Space at the same frame: the hosted one main, the twin transient",
            windows: [std(71192, page, .margin, onScreen: true), std(71300, page, .margin, onScreen: false)],
            app: .init(launchedByMargin: true, hosted: [71192]), want: [71192: .main, 71300: .transient], why: [71300: "twin"]),
        Row(name: "Messages' hosted window in no Space, its twin in Margin's Space at its frame: the twin is main (its app replaced it), the hosted one transient",
            windows: [W(number: 71192, bounds: page, onScreen: false, place: .nowhere, everPlaced: true, role: "AXWindow", subrole: "AXStandardWindow"), std(71300, page, .margin, onScreen: true)],
            app: .init(launchedByMargin: true, hosted: [71192]), want: [71192: .transient, 71300: .main], why: [71300: "replaces 71192", 71192: "replaced"]),
        Row(name: "Messages' twin Accessibility calls its main window (both in Margin's Space): the twin is main",
            windows: [std(71192, page, .margin, onScreen: true), { var t = std(71300, page, .margin, onScreen: true); t.axMain = true; return t }()],
            app: .init(launchedByMargin: true, hosted: [71192]), want: [71192: .transient, 71300: .main]),
        Row(name: "Messages' hosted window in no Space with no other window: still main (where it is is the reconciler's business)",
            windows: [W(number: 71192, bounds: page, onScreen: false, place: .nowhere, everPlaced: true)],
            app: .init(launchedByMargin: true, hosted: [71192]), want: [71192: .main]),
        // Mail, 14:06: its toolbar strip 1512×88 at the display's top; its Settings window.
        Row(name: "Mail's 1512×88 toolbar strip: strip",
            windows: [std(69767, area, .margin, onScreen: true), W(number: 69769, bounds: CGRect(x: 0, y: 33, width: 1512, height: 88), onScreen: true, place: .margin, everPlaced: true, role: "AXWindow", subrole: "AXUnknown")],
            app: .init(launchedByMargin: true, hosted: [69767]), want: [69767: .main, 69769: .strip]),
        Row(name: "a strip as wide as the page area only (a member's): strip",
            windows: [std(69767, page, .margin), W(number: 69770, bounds: CGRect(x: 260, y: 41, width: 1244, height: 52), place: .margin, everPlaced: true)],
            app: .init(launchedByMargin: true, hosted: [69767]), want: [69767: .main, 69770: .strip]),
        Row(name: "Mail's Settings window (a standard window that can't go full screen, its main one can): auxiliary",
            windows: [std(69767, page, .margin, onScreen: true), std(69800, CGRect(x: 500, y: 200, width: 800, height: 600), .margin, onScreen: true, full: false)],
            app: .init(launchedByMargin: true, hosted: [69767]), want: [69767: .main, 69800: .auxiliary], why: [69800: "can't go full screen"]),
        Row(name: "a sheet (role AXSheet) on the main window: dialog",
            windows: [std(5, page, .margin), W(number: 6, bounds: CGRect(x: 600, y: 41, width: 500, height: 300), place: .margin, everPlaced: true, role: "AXSheet")],
            app: .init(launchedByMargin: true, hosted: [5]), want: [5: .main, 6: .dialog], why: [6: "a sheet"]),
        Row(name: "an alert (AXDialog, 260×300) beside the main window: dialog",
            windows: [std(5, page, .margin), W(number: 7, bounds: CGRect(x: 600, y: 300, width: 260, height: 300), place: .margin, everPlaced: true, role: "AXWindow", subrole: "AXDialog")],
            app: .init(launchedByMargin: true, hosted: [5]), want: [5: .main, 7: .dialog]),
        Row(name: "a tooltip (layer 3), a menu (layer 101), a popover (role AXPopover), a tiny window: transient",
            windows: [std(5, page, .margin), W(number: 8, layer: 3, bounds: CGRect(x: 400, y: 400, width: 120, height: 22)), W(number: 9, layer: 101, bounds: CGRect(x: 300, y: 60, width: 220, height: 400)),
                      W(number: 10, bounds: CGRect(x: 300, y: 60, width: 320, height: 240), place: .margin, role: "AXPopover"), W(number: 11, bounds: CGRect(x: 0, y: 0, width: 80, height: 20), place: .margin)],
            app: .init(launchedByMargin: true, hosted: [5]), want: [5: .main, 8: .transient, 9: .transient, 10: .transient, 11: .transient], why: [8: "layer 3", 11: "under 100 pt"]),
        Row(name: "an inspector (AXFloatingWindow): auxiliary",
            windows: [std(5, page, .margin), W(number: 12, bounds: CGRect(x: 1100, y: 100, width: 300, height: 500), place: .margin, everPlaced: true, role: "AXWindow", subrole: "AXFloatingWindow")],
            app: .init(launchedByMargin: true, hosted: [5]), want: [5: .main, 12: .auxiliary]),
        // Safari, 14:05: the window opened only to wake a profile.
        Row(name: "Safari's window opened only to wake a profile: leftover (even made after the hosted one)",
            windows: [std(69700, page, .margin), std(69750, desk, .parked)],
            app: .init(launchedByMargin: false, hosted: [69700], woken: [69750]), want: [69700: .main, 69750: .leftover], why: [69750: "wake"]),
        Row(name: "Calculator (its only window can't go full screen, fixed size): main, not auxiliary",
            windows: [std(40, CGRect(x: 400, y: 300, width: 230, height: 408), .margin, full: false)], app: .init(launchedByMargin: true, hosted: [40]), want: [40: .main]),
        Row(name: "a second document window opened after Margin hosted the app: auxiliary (not a leftover)",
            windows: [std(5, page, .margin), std(9, desk, .margin)], app: .init(launchedByMargin: true, hosted: [5]), want: [5: .main, 9: .auxiliary]),
        Row(name: "its hosted window gone, a new one in its place: the new one main (its only window)",
            windows: [std(9, page, .margin)], app: .init(launchedByMargin: true, hosted: [5]), want: [9: .main], why: [9: "only window"]),
        Row(name: "nothing hosted, two windows: the one in a Space is main, the one in no Space auxiliary",
            windows: [W(number: 3, bounds: desk, place: .nowhere, everPlaced: true), unread(4, desk.offsetBy(dx: 50, dy: 50), .desktop)],
            app: .init(launchedByMargin: true), want: [3: .auxiliary, 4: .main], why: [4: "the one in a Space"]),
        Row(name: "nothing hosted, two in a Space: Accessibility's main window is main",
            windows: [{ var w = std(3, desk, .desktop); w.axMain = true; return w }(), std(4, desk.offsetBy(dx: 50, dy: 50), .desktop)],
            app: .init(launchedByMargin: true), want: [3: .main, 4: .auxiliary], why: [3: "Accessibility's main window"]),
        Row(name: "nothing hosted, a tie: the one that was main stays main", windows: [std(3, desk, .desktop), std(4, desk.offsetBy(dx: 50, dy: 50), .desktop)],
            app: .init(launchedByMargin: true, previousMains: [3]), want: [3: .main, 4: .auxiliary], why: [3: "main before"]),
        Row(name: "an app with no window (Maps running windowless, 15:19): nothing", windows: [], app: .init(launchedByMargin: true), want: [:]),
    ]
    for row in rows {
        let got = WindowKinds.classify(row.windows, app: row.app, in: placement)
        let kinds = got.mapValues(\.kind)
        let whys = row.why.allSatisfy { n, part in got[n]?.why.contains(part) == true }
        check("kinds: \(row.name)", kinds == row.want && whys, "\(got.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value.kind.rawValue) (\($0.value.why))" })")
    }
    // With no placement yet (nothing hosted on that display): no strip rule; a 1512×88 window is then too short a side.
    let none = WindowKinds.classify([W(number: 1, bounds: CGRect(x: 0, y: 33, width: 1512, height: 88), place: .margin)], app: .init(), in: .zero)
    check("kinds: no placement: no strip (a short window is transient)", none[1]?.kind == .transient, "\(none)")
    // Never a bundle id or a title in the rules: the same windows of any app classify the same.
    check("kinds: the rules read no app's name (WindowKinds.App has none)", Mirror(reflecting: WindowKinds.App()).children.allSatisfy { $0.label != "bundleId" && $0.label != "title" })
    // Each window gets exactly one kind, every window of the input one.
    let all = rows.flatMap(\.windows)
    let once = WindowKinds.classify(all.enumerated().map { var w = $0.element; w.number = $0.offset + 1; return w }, app: .init(launchedByMargin: true, hosted: [1]), in: placement)
    check("kinds: every window gets a kind", once.count == all.count && once.values.filter { $0.kind == .main }.count >= 1, "\(once.count) of \(all.count)")
}

// ---- the log lines ----

func hostModelLineTests() {
    var app = HostModelApp(pid: 42, bundleId: "com.apple.MobileSMS", launchedByMargin: true, since: 0)
    let page = CGRect(x: 260, y: 41, width: 1244, height: 933), placement = HostPlacement(page: page, area: CGRect(x: 0, y: 33, width: 1512, height: 949))
    var w = HostModelWindow(number: 71192, at: 0)
    w.bounds = page
    w.spaces = [8438]
    w.place = .margin
    w.everPlaced = true
    w.onScreen = true
    app.windows[71192] = w
    app.hosted = [71192: "app:com.apple.MobileSMS"]
    var before = app.seen, mains = app.mains
    app.classify(in: placement, at: 1)
    check("model: first sight: its main said with its place and on-screen state", app.change(from: before, mainsBefore: mains) == "main none → 71192; 71192 main (the window Margin hosts), in [8438] (Margin's Space), on screen",
          app.change(from: before, mainsBefore: mains) ?? "nil")
    before = app.seen
    mains = app.mains
    app.classify(in: placement, at: 2)
    check("model: nothing changed: nothing said", app.change(from: before, mainsBefore: mains) == nil)
    app.windows[71192]?.spaces = []
    app.windows[71192]?.place = .nowhere
    app.windows[71192]?.onScreen = false
    var twin = HostModelWindow(number: 71300, at: 3)
    twin.bounds = page
    twin.spaces = [8438]
    twin.place = .margin
    twin.everPlaced = true
    twin.onScreen = true
    app.windows[71300] = twin
    app.classify(in: placement, at: 3)
    let line = app.change(from: before, mainsBefore: mains) ?? ""
    check("model: its window out of every Space, a twin in its place: the main's change, each window's, numbers and kinds only",
          line.hasPrefix("main 71192 → 71300; 71192 main → transient (replaced by its app: 71300 at its frame is main), in [8438] (Margin's Space) → in no Space, on screen → off screen; 71300 main (replaces 71192"), line)
    before = app.seen
    mains = app.mains
    app.windows[71192] = nil
    app.classify(in: placement, at: 4)
    check("model: a transient window gone: nothing said (transients aren't followed in the log)", app.change(from: before, mainsBefore: mains) == nil, app.change(from: before, mainsBefore: mains) ?? "")
    before = app.seen
    mains = app.mains
    app.windows[71300] = nil
    check("model: its main gone: said", app.change(from: before, mainsBefore: mains) == "main 71300 → none; 71300 gone (was main)", app.change(from: before, mainsBefore: mains) ?? "nil")
    check("model: the dev hook's summary", app.summary == "com.apple.MobileSMS main none", app.summary)
}

// ---- the observer on the stand-in ----

func hostObserverTests() {
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let margin = FakeHostWorld.marginSpace
    final class Lines { var all: [String] = [] }
    func rig() -> (FakeHostWorld, FakeObservation, HostObserver, Lines) {
        let w = FakeHostWorld()
        let ax = FakeObservation(w)
        let o = HostObserver(system: w, source: ax)
        let lines = Lines()
        o.say = { lines.all.append($0) }
        o.schedule = { _, _ in } // (each test flushes Accessibility's reads itself)
        return (w, ax, o, lines)
    }
    func window(_ w: FakeHostWorld, _ pid: pid_t, _ frame: CGRect, in spaces: [UInt64], role: String? = nil) -> Int {
        let n = w.nextWindow
        w.nextWindow += 1
        var win = FakeHostWorld.Win(pid: pid, spaces: spaces, frame: frame)
        win.axRole = role
        w.wins[n] = win
        w.apps[pid]?.windows.append(n)
        return n
    }

    // ---- Accessibility's notifications → the model ----
    do {
        let (w, ax, o, lines) = rig()
        w.autoOnScreen = true
        let pid = w.start("com.apple.MobileSMS", policy: .accessory, windows: 1)
        let main = w.apps[pid]!.windows[0]
        w.wins[main]?.spaces = [margin]
        w.wins[main]?.frame = page
        let tracked = [HostObserver.Tracked(pid: pid, bundleId: "com.apple.MobileSMS", launchedByMargin: true, hosted: [main: "app:com.apple.MobileSMS"])]
        o.update(tracked, onScreen: w.onScreenWindows(), seen: [:], placement: placement, marginSpace: margin)
        hostRun { await o.flush(pid) }
        let app = o.model.apps[pid]
        check("observer: followed once hosted: watched by Accessibility, its window main in Margin's Space, on screen, read by Accessibility",
              ax.watched[pid] != nil && app?.windows[main]?.kind == .main && app?.windows[main]?.place == .margin && app?.windows[main]?.onScreen == true
              && app?.windows[main]?.ax?.subrole == "AXStandardWindow", "\(String(describing: app))")
        check("observer: one line for it, numbers and kinds only", lines.all.count == 1 && lines.all[0].hasPrefix("host: model: com.apple.MobileSMS (pid \(pid)): main none → \(main)"), "\(lines.all)")
        // A Settings window and a sheet, each heard as created: read by Accessibility, followed at once.
        let settings = window(w, pid, CGRect(x: 600, y: 200, width: 700, height: 500), in: [margin])
        w.wins[settings]?.canFullScreen = false
        let sheet = window(w, pid, CGRect(x: 600, y: 41, width: 500, height: 300), in: [margin], role: "AXSheet")
        ax.post(pid, .created, settings)
        ax.post(pid, .created, sheet)
        hostRun { await o.flush(pid) }
        let kinds = o.model.apps[pid]?.windows.mapValues(\.kind) ?? [:]
        check("observer: windows heard as created: followed before the next poll, a Settings window auxiliary, a sheet dialog",
              kinds == [main: .main, settings: .auxiliary, sheet: .dialog] && ax.reads.last?.windows == [settings, sheet], "\(kinds) \(ax.reads.map(\.windows))")
        check("observer: their arrival said in one line (one read)", lines.all.count == 2 && lines.all[1].contains("\(settings) auxiliary (can't go full screen") && lines.all[1].contains("\(sheet) dialog (a sheet)"), "\(lines.all)")
        // Its main window changed by Accessibility (to the Settings window): the hosted one stays main.
        w.main[pid] = settings
        ax.post(pid, .main, settings)
        hostRun { await o.flush(pid) }
        check("observer: Accessibility's main window changed to another window: read, the hosted one still main", o.model.apps[pid]?.axMain == settings && o.model.apps[pid]?.mains == [main] && lines.all.count == 2, "\(lines.all)")
        // The sheet closed: gone at the second poll that doesn't read it (one can miss mid-transition).
        w.closeWindow(sheet)
        ax.post(pid, .destroyed, sheet)
        o.update(tracked, onScreen: w.onScreenWindows(), seen: [:], placement: placement, marginSpace: margin)
        let afterOne = o.model.apps[pid]?.windows[sheet] != nil
        o.update(tracked, onScreen: w.onScreenWindows(), seen: [:], placement: placement, marginSpace: margin)
        check("observer: a window closed: gone at the second poll that doesn't read it, said once", afterOne && o.model.apps[pid]?.windows[sheet] == nil
              && lines.all.filter { $0.contains("\(sheet) gone (was dialog)") }.count == 1, "\(lines.all)")
        check("observer: the notifications counted, Accessibility read once per flush", o.cost.notes == 4 && o.cost.axReads == 3, "\(o.cost)")
        // Given back: unwatched, dropped, said.
        o.update([], onScreen: nil, seen: [:], placement: placement, marginSpace: margin)
        check("observer: given back: Accessibility's watch stopped, the app dropped, said once", ax.unwatched == [pid] && o.model.apps.isEmpty
              && lines.all.last == "host: model: com.apple.MobileSMS (pid \(pid)): given back, no longer followed", "\(lines.all)")
    }

    // ---- a window replaced, and a window leaving every Space (Messages, 15:20) ----
    do {
        let (w, _, o, lines) = rig()
        w.autoOnScreen = true
        let pid = w.start("com.apple.MobileSMS", policy: .accessory, windows: 1)
        let hosted = w.apps[pid]!.windows[0]
        w.wins[hosted]?.spaces = [margin]
        w.wins[hosted]?.frame = page
        let tracked = [HostObserver.Tracked(pid: pid, bundleId: "com.apple.MobileSMS", launchedByMargin: true, hosted: [hosted: "app:com.apple.MobileSMS"])]
        func poll() { o.update(tracked, onScreen: w.onScreenWindows(), seen: [:], placement: placement, marginSpace: margin) }
        poll()
        let first = lines.all.count
        poll()
        poll()
        check("observer: nothing changes: nothing said", lines.all.count == first, "\(lines.all)")
        // Out of every Space (no twin): still main, its place and on-screen state said.
        w.wins[hosted]?.spaces = []
        poll()
        check("observer: its window out of every Space: still main, said once (in no Space, off screen)", o.model.apps[pid]?.mains == [hosted] && lines.all.count == first + 1
              && lines.all.last?.hasSuffix("\(hosted) in [\(margin)] (Margin's Space) → in no Space, on screen → off screen") == true, "\(lines.all)")
        poll()
        check("observer: ...and not again while it stays there", lines.all.count == first + 1)
        w.wins[hosted]?.spaces = [margin]
        poll()
        check("observer: back in Margin's Space: said", lines.all.count == first + 2 && lines.all.last?.hasSuffix("\(hosted) in no Space → in [\(margin)] (Margin's Space), off screen → on screen") == true, "\(lines.all)")
        // Replaced: out of every Space again, a new window of its app at its frame in Margin's Space.
        w.wins[hosted]?.spaces = []
        let twin = window(w, pid, page, in: [margin])
        poll()
        check("observer: replaced by its app (a new window at its frame in Margin's Space, its own in none): the new one main, the old one transient",
              o.model.apps[pid]?.windows[twin]?.kind == .main && o.model.apps[pid]?.windows[hosted]?.kind == .transient
              && lines.all.last?.hasPrefix("host: model: com.apple.MobileSMS (pid \(pid)): main \(hosted) → \(twin); \(hosted) main → transient (replaced by its app") == true, "\(lines.all)")
        // The old one back in Margin's Space: the hosted one main again, the new one its twin.
        w.wins[hosted]?.spaces = [margin]
        poll()
        check("observer: the hosted one back at the same frame: main again, the other its twin (transient)",
              o.model.apps[pid]?.windows[hosted]?.kind == .main && o.model.apps[pid]?.windows[twin]?.kind == .transient
              && o.model.apps[pid]?.windows[twin]?.why.contains("a twin of the main window \(hosted)") == true, "\(String(describing: o.model.apps[pid]?.windows[twin]))")
        // The hosted one closed for good: the twin main (its only window).
        w.closeWindow(hosted)
        poll()
        poll()
        check("observer: the hosted one gone: its twin main", o.model.apps[pid]?.mains == [twin] && o.model.apps[pid]?.windows[hosted] == nil, "\(String(describing: o.model.apps[pid]))")
    }

    // ---- a restored full-screen window that came up before the app was hosted (Safari, 15:19) ----
    do {
        let (w, _, o, lines) = rig()
        let pid = w.start("com.apple.Safari", policy: .accessory, windows: 3)
        let restored = w.apps[pid]!.windows
        // Two restored into full-screen Spaces of their own, one on the Desktop.
        for n in restored.prefix(2) {
            let space = w.nextId
            w.nextId += 2
            w.tiles[space] = [space + 1]
            w.owner[space] = pid
            w.wins[n]?.fullScreen = true
            w.wins[n]?.spaces = [space]
        }
        // The window Margin asked for, made after them, parked.
        let mine = window(w, pid, page, in: [])
        let priv = w.createPrivateSpace()!
        w.wins[mine]?.priv = priv
        let tracked = [HostObserver.Tracked(pid: pid, bundleId: "com.apple.Safari", launchedByMargin: true, hosted: [mine: "safari:p646"], parked: [mine: priv])]
        // Without the engine's list from its open: the restored windows (off screen) aren't known.
        let o2 = HostObserver(system: w, source: nil)
        o2.say = { _ in }
        o2.update(tracked, onScreen: [], seen: [:], placement: placement, marginSpace: margin)
        // With it (the list the engine read as it told Safari's new window apart): every one.
        o.update(tracked, onScreen: [], seen: [pid: w.serverWindows(pid: pid) ?? []], placement: placement, marginSpace: margin)
        let kinds = o.model.apps[pid]?.windows.mapValues(\.kind) ?? [:]
        let places = o.model.apps[pid]?.windows.mapValues(\.place) ?? [:]
        check("observer: Safari's windows restored before it was hosted (two in full-screen Spaces of their own, one on the Desktop): known from the engine's own list, leftovers; Margin's window main, parked",
              kinds == [restored[0]: .leftover, restored[1]: .leftover, restored[2]: .leftover, mine: .main]
              && places == [restored[0]: .fullScreen, restored[1]: .fullScreen, restored[2]: .desktop, mine: .parked], "\(kinds) \(places)")
        check("observer: ...said in one line, each with its Spaces", lines.all.count == 1 && lines.all[0].contains("\(restored[0]) leftover (made before the window Margin hosts (\(mine))") && lines.all[0].contains("\(mine) main (the window Margin hosts), parked"), "\(lines.all)")
        check("observer: ...the observer reads no list of its own (with none from the engine, the off-screen ones aren't known)", o2.model.apps[pid]?.windows.keys.sorted() == [mine], "\(String(describing: o2.model.apps[pid]?.windows.keys.sorted()))")
    }

    // ---- through the engine: an app opened, polled, closed; Maps restored in full screen ----
    do {
        let w = FakeHostWorld()
        w.autoOnScreen = true
        let ax = FakeObservation(w)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-host-model-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let e = HostEngine(system: w, marker: folder.appendingPathComponent(HostMarker.fileName), pid: 1, observation: ax)
        e.options.privateRetire = 0
        e.observer.schedule = { _, _ in }
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        var listReads = 0
        w.onScreenRead = { listReads += 1 }
        let textEdit = HostTarget.app("com.apple.TextEdit")
        let r = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: margin) }
        let pid = w.running(bundleId: "com.apple.TextEdit").first?.pid ?? 0
        let n = e.hosts[textEdit.id]?.window ?? 0
        let watchedAfterOpen = ax.watched[pid] != nil && e.observer.model.apps[pid] != nil
        listReads = 0
        e.poll()
        let polledReads = listReads
        e.poll()
        check("engine: an app opened: followed from the end of its open (watched by Accessibility), its window main in Margin's Space after the poll",
              r == .shown(textEdit.id, placed: true) && watchedAfterOpen && e.observer.model.apps[pid]?.windows[n]?.kind == .main && e.observer.model.apps[pid]?.windows[n]?.place == .margin,
              "\(String(describing: r)) \(String(describing: e.observer.model.apps[pid]))")
        check("engine: the poll's on-screen list read once a poll, the observer reading none of its own", polledReads == 1 && e.observer.cost.updates == 2, "\(polledReads) \(e.observer.cost)")
        check("engine: the model said in the log (host: model: …), numbers and kinds only", lines.contains { $0.hasPrefix("host: model: com.apple.TextEdit (pid \(pid)): main none → \(n)") }, "\(lines.filter { $0.contains("model") })")
        let front = e.readShown()
        check("engine: the dev hook's line says the model (its apps, its cost a poll, the shown app's main)", front.contains("; model: 1 app, ") && front.contains("µs a poll") && front.contains("; com.apple.TextEdit main \(n) in [\(margin)] (Margin's Space) on screen"), front)
        hostRun { await e.close(textEdit.id) }
        e.poll()
        check("engine: its row closed (its app quit): no longer followed, Accessibility's watch stopped", e.observer.model.apps[pid] == nil && ax.unwatched.contains(pid) && lines.contains { $0.contains("given back, no longer followed") }, "\(ax.unwatched)")
        Diagnostics.echo = echo
    }
    do {
        let w = FakeHostWorld()
        w.installed.insert("com.apple.Maps")
        w.restoredFullScreen = ["com.apple.Maps"]
        w.axCurrentOnly = true
        w.staged = true
        let e = HostEngine(system: w, marker: nil, pid: 1, observation: FakeObservation(w))
        e.options.privateRetire = 0
        e.observer.schedule = { _, _ in }
        let echo = Diagnostics.echo
        var lines: [String] = []
        Diagnostics.echo = { lines.append($0) }
        let maps = HostTarget.app("com.apple.Maps")
        let r = hostRun { await e.open(app: maps, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: margin) }
        e.poll()
        Diagnostics.echo = echo
        let pid = w.running(bundleId: "com.apple.Maps").first?.pid ?? 0
        let n = e.hosts[maps.id]?.window ?? 0
        check("engine: Maps restored in full screen in a Space of its own: placed as before, and its window main in the model, in Margin's Space",
              r == .shown(maps.id, placed: true) && e.observer.model.apps[pid]?.mains == [n] && e.observer.model.apps[pid]?.windows[n]?.place == .margin, "\(String(describing: e.observer.model.apps[pid])) \(lines.filter { $0.contains("model") })")
    }

    // ---- the cost on the stand-in: five apps, each a main window, a Settings window, a strip and a menu ----
    do {
        let (w, _, o, _) = rig()
        w.autoOnScreen = true
        var tracked: [HostObserver.Tracked] = []
        var menus: [ServerWindow] = []
        for i in 0..<5 {
            let pid = w.start("test.app\(i)", policy: .accessory, windows: 1)
            let main = w.apps[pid]!.windows[0]
            var parked: [Int: UInt64] = [:]
            if i == 0 { w.wins[main]?.spaces = [margin] } else { let p = w.createPrivateSpace()!; w.wins[main]?.priv = p; parked[main] = p }
            w.wins[main]?.frame = page
            _ = window(w, pid, CGRect(x: 600, y: 200, width: 700, height: 500), in: [margin])
            _ = window(w, pid, FakeHostWorld.stripFrame, in: [margin])
            let menu = w.nextWindow
            w.nextWindow += 1
            menus.append(ServerWindow(number: menu, pid: pid, layer: 101, bounds: CGRect(x: 300, y: 60, width: 220, height: 400)))
            tracked.append(HostObserver.Tracked(pid: pid, bundleId: "test.app\(i)", launchedByMargin: true, hosted: [main: "app:test.app\(i)"], parked: parked))
        }
        let list = (w.onScreenWindows() ?? []) + menus
        o.update(tracked, onScreen: list, seen: [:], placement: placement, marginSpace: margin)
        let base = o.cost
        let polls = 400
        for _ in 0..<polls { o.update(tracked, onScreen: list, seen: [:], placement: placement, marginSpace: margin) }
        let c = o.cost
        let perPoll = (c.seconds - base.seconds) / Double(polls) * 1e6
        let reads = Double(c.boundsReads - base.boundsReads + c.spacesReads - base.spacesReads) / Double(polls)
        check(String(format: "observer: cost on the stand-in: %.0f µs a poll for 5 apps (20 windows: the menus followed by the list alone), %.0f window reads a poll (bounds and Spaces of 15), no list of its own", perPoll, reads),
              reads == 30 && c.typeReads == base.typeReads && perPoll < 2000, "\(c)")
        print(String(format: "  observer cost: %.1f µs a poll (5 apps, 20 windows; %d polls)", perPoll, polls))
    }
}
