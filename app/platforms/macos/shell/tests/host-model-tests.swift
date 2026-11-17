// The hosting core's stage 2 (docs/HOSTING-CORE.md): the window kinds (WindowKinds.swift), a row per case the real
// sessions showed (2026-11-17 07:52, 14:05, 15:19: Safari's restored windows, Maps restored in full screen, the Phone's
// dialog-subrole window, Messages' twin, Mail's strip and settings window, sheets, menus and tooltips), the model's log
// lines (HostModel.swift). Part of tests.swift's run.
import AppKit
import Foundation

func hostModelTests() {
    windowKindsTests()
    hostModelLineTests()
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
