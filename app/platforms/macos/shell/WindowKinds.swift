// The hosting core's window kinds (docs/HOSTING-CORE.md, principle 2): every window of an app Margin hosts gets one
// kind from generic rules on its layer, size, position, Accessibility's role and subrole, and its history. Never a
// bundle id. Pure: one function of what's observed (HostModel.swift), tested on its own (tests/host-model-tests.swift,
// a row per case the real sessions showed). Stage 2: the kinds are only logged; nothing acts on them yet.
//
// The kinds:
//   main       the window that is the app (shown at the page area, or parked): one per host
//   auxiliary  settings, inspectors, floating panels, the app's other windows (a second document, the person's own)
//   dialog     alerts and sheets (shown on top of the main window)
//   strip      a full-screen window's toolbar or title band: the page area's width at least, at most 150 pt tall
//   leftover   restored from an earlier session (made before the window Margin hosts, in an app Margin started), or
//              opened by Margin only to wake something: to be closed
//   transient  menus, tooltips, popovers (above layer 0, or tiny), spares never ordered in, a twin at the main
//              window's frame, a hosted window its app replaced: nothing to do with them
//
// The rules, in order (the first that applies):
//   1. above layer 0                                              transient
//   2. Accessibility's role a menu, a help tag or a popover       transient
//   3. the page area's width at least, at most 150 pt tall        strip
//   4. under 100 pt on a side                                     transient
//   5. opened by Margin only to wake its app                      leftover
//   6. never ordered in (no Space, off screen, never seen in one) while another of its app's windows is: a spare
//                                                                 transient
//   7. Accessibility's role a sheet                               dialog
//      subrole a floating window                                  auxiliary
//      subrole a dialog: a dialog, unless its app has no other window that could be its main one and it's hosted or
//      at least 400×300 (the Phone's only window is one)          main candidate
//      anything else (a standard window, or unread)               main candidate
//   8. a candidate made before the window Margin hosts (a lower window number: the window server numbers windows in
//      the order they're made), in an app Margin started, not hosted: restored                     leftover
//   9. a candidate that can't go full screen while another can (a settings window)                  auxiliary
//  10. the mains: each hosted candidate its app didn't replace (a hosted window is replaced when it's in no Space and
//      another window is in one at its frame, or when another at its frame is Accessibility's main window and it isn't);
//      none: the best of the candidates by, in order: in a Space (or on screen), Accessibility's main window, on
//      screen, main before, focused, not minimized, a standard window, the bigger, the newer.
//  11. the other candidates: at a main window's frame (within 4 pt) a twin (transient), else auxiliary.

import AppKit

nonisolated enum WindowKind: String, Sendable, Codable, CaseIterable {
    case main, auxiliary, dialog, strip, leftover, transient
}

// Where a window is: its Spaces by the window server (mask 7, user Spaces only) and Margin's own record of the private
// Spaces it made (mask 7 lists none: a parked window reads as in no user Space).
nonisolated enum WindowPlace: Equatable, Sendable {
    case margin // Margin's full-screen Space, alone
    case desktop // a Desktop
    case fullScreen // a full-screen Space that isn't Margin's (its own, or another app's)
    case several // more than one user Space (mid-transition, or a window on every Space)
    case parked // a private Space Margin made
    case nowhere // in no Space at all
    case unread

    // In a Space of some kind (a window ordered in somewhere).
    var placed: Bool { self != .nowhere && self != .unread }

    var text: String {
        switch self {
        case .margin: return "Margin's Space"
        case .desktop: return "a Desktop"
        case .fullScreen: return "a full-screen Space"
        case .several: return "several Spaces"
        case .parked: return "parked"
        case .nowhere: return "no Space"
        case .unread: return "Spaces unread"
        }
    }
}

nonisolated enum WindowKinds {
    // One window as the classification reads it (HostModelWindow has it all, with its history).
    struct Window: Equatable, Sendable {
        var number: Int
        var layer = 0
        var bounds: CGRect
        var alpha = 1.0
        var onScreen: Bool? = nil
        var place = WindowPlace.unread
        var everPlaced = false // seen in a Space (or on screen) at least once
        var role: String? = nil // Accessibility's (nil: unread)
        var subrole: String? = nil
        var fullScreen: Bool? = nil
        var canFullScreen: Bool? = nil
        var minimized: Bool? = nil
        var axMain = false // its app's main window, by Accessibility
        var axFocused = false
    }

    // What Margin knows of the app: whether it started it, the windows it hosts, the ones it opened only to wake it, and
    // the windows that were main at the last classification (so a tie keeps the main where it was).
    struct App: Equatable, Sendable {
        var launchedByMargin = false
        var hosted: Set<Int> = []
        var woken: Set<Int> = []
        var previousMains: Set<Int> = []
    }

    struct Verdict: Equatable, Sendable {
        let kind: WindowKind
        let why: String
    }

    static let stripMaxHeight: CGFloat = 150
    static let tinySide: CGFloat = 100
    static let twinWithin: CGFloat = 4
    static let bigDialog = CGSize(width: 400, height: 300)
    static let transientRoles: Set<String> = ["AXMenu", "AXMenuBar", "AXHelpTag", "AXPopover"]
    static let floatingSubroles: Set<String> = ["AXFloatingWindow", "AXSystemFloatingWindow"]
    static let dialogSubroles: Set<String> = ["AXDialog", "AXSystemDialog"]

    // As the engine's own (HostEngine.isStrip): the page area's width at least (the display's for one that went full
    // screen on its own), at most 150 pt tall. Nothing to measure against (no placement yet): no strip.
    static func isStrip(_ b: CGRect, in p: HostPlacement) -> Bool {
        guard b.width > 0, b.height > 0, b.height <= stripMaxHeight else { return false }
        let wide: CGFloat
        switch (p.area.width > 0, p.page.width > 0) {
        case (true, true): wide = min(p.area.width * 0.9, p.page.width - 2)
        case (true, false): wide = p.area.width * 0.9
        case (false, true): wide = p.page.width - 2
        case (false, false): return false
        }
        return b.width >= wide
    }

    static func near(_ a: CGRect, _ b: CGRect) -> Bool { HostLayout.near(a, b, within: twinWithin) }

    private static func size(_ b: CGRect) -> String { "\(Int(b.width))×\(Int(b.height))" }

    // Each window's kind and why, by its number.
    static func classify(_ windows: [Window], app: App, in placement: HostPlacement) -> [Int: Verdict] {
        var out: [Int: Verdict] = [:]
        var rest: [Window] = []
        for w in windows.sorted(by: { $0.number < $1.number }) {
            if w.layer != 0 { out[w.number] = Verdict(kind: .transient, why: "layer \(w.layer)"); continue }
            if let role = w.role, transientRoles.contains(role) { out[w.number] = Verdict(kind: .transient, why: "role \(role)"); continue }
            if isStrip(w.bounds, in: placement) { out[w.number] = Verdict(kind: .strip, why: "\(size(w.bounds)): the page area's width, at most \(Int(stripMaxHeight)) pt tall"); continue }
            if w.bounds.width < tinySide || w.bounds.height < tinySide { out[w.number] = Verdict(kind: .transient, why: "\(size(w.bounds)): under \(Int(tinySide)) pt on a side"); continue }
            if app.woken.contains(w.number) { out[w.number] = Verdict(kind: .leftover, why: "opened by Margin only to wake its app"); continue }
            rest.append(w)
        }
        // 6. Spares: never ordered in while another is.
        func placedNow(_ w: Window) -> Bool { w.place.placed || w.onScreen == true }
        let orderedIn = rest.filter { placedNow($0) || $0.everPlaced }.count
        rest = rest.filter { w in
            guard !placedNow(w), !w.everPlaced, !app.hosted.contains(w.number), orderedIn > 0 else { return true }
            out[w.number] = Verdict(kind: .transient, why: "never ordered in (in no Space, off screen) while \(orderedIn) of its app's windows \(orderedIn == 1 ? "is" : "are"): a spare")
            return false
        }
        // 7. Accessibility's role and subrole.
        var candidates: [Window] = []
        var dialogs: [Window] = []
        for w in rest {
            if w.role == "AXSheet" { out[w.number] = Verdict(kind: .dialog, why: "a sheet"); continue }
            if let s = w.subrole, floatingSubroles.contains(s) { out[w.number] = Verdict(kind: .auxiliary, why: "a floating panel (\(s))"); continue }
            if let s = w.subrole, dialogSubroles.contains(s) { dialogs.append(w); continue }
            candidates.append(w)
        }
        // 8. Restored: made before the window Margin hosts, in an app Margin started.
        if app.launchedByMargin, let first = app.hosted.min() {
            candidates = candidates.filter { w in
                guard !app.hosted.contains(w.number), w.number < first else { return true }
                out[w.number] = Verdict(kind: .leftover, why: "made before the window Margin hosts (\(first)) in an app Margin started: restored, in \(w.place.text)")
                return false
            }
        }
        // (A dialog-subrole window as the main one: only with no other window that could be.)
        var promoted: Set<Int> = []
        if candidates.isEmpty {
            for w in dialogs where app.hosted.contains(w.number) || (w.bounds.width >= bigDialog.width && w.bounds.height >= bigDialog.height) {
                candidates.append(w)
                promoted.insert(w.number)
            }
        }
        for w in dialogs where !promoted.contains(w.number) { out[w.number] = Verdict(kind: .dialog, why: "a dialog (\(w.subrole ?? "?"))") }
        // 9. Can't go full screen while another can.
        let canFull = candidates.filter { $0.canFullScreen == true }.count
        if canFull > 0 {
            candidates = candidates.filter { w in
                guard w.canFullScreen == false, !app.hosted.contains(w.number) else { return true }
                out[w.number] = Verdict(kind: .auxiliary, why: "can't go full screen while \(canFull) of its app's windows can (a settings or utility window)")
                return false
            }
        }
        // 10. The mains.
        func replacement(of h: Window) -> Window? {
            candidates.first { c in
                !app.hosted.contains(c.number) && near(c.bounds, h.bounds) && placedNow(c) && (h.place == .nowhere || (c.axMain && !h.axMain))
            }
        }
        var mains: [Int: String] = [:]
        var replaced: [Int: Int] = [:]
        for h in candidates where app.hosted.contains(h.number) {
            if let c = replacement(of: h) { replaced[h.number] = c.number; continue }
            let dialog = promoted.contains(h.number) ? ", a dialog-subrole window: its app's only one that could be main" : ""
            mains[h.number] = "the window Margin hosts" + (h.axMain ? ", Accessibility's main window too" : "") + dialog
        }
        if mains.isEmpty {
            let pool = candidates.filter { replaced[$0.number] == nil }
            if let (best, why) = best(of: pool, app: app) {
                let dialog = promoted.contains(best.number) ? " (a dialog-subrole window: its app's only one that could be main)" : ""
                if let old = replaced.first(where: { $0.value == best.number })?.key {
                    mains[best.number] = "replaces \(old), the window Margin hosts (\(candidates.first { $0.number == old }?.place == .nowhere ? "in no Space, this one at its frame in \(best.place.text)" : "this one at its frame is Accessibility's main window"))"
                } else {
                    mains[best.number] = why + dialog
                }
            }
        }
        for (n, why) in mains { out[n] = Verdict(kind: .main, why: why) }
        // 11. The rest of the candidates.
        let mainWindows = candidates.filter { mains[$0.number] != nil }
        for w in candidates where mains[w.number] == nil {
            if let by = replaced[w.number] {
                out[w.number] = Verdict(kind: .transient, why: "replaced by its app: \(by) at its frame\(mains[by] == nil ? "" : " is main")")
            } else if let twin = mainWindows.first(where: { near($0.bounds, w.bounds) }) {
                out[w.number] = Verdict(kind: .transient, why: "a twin of the main window \(twin.number), at its frame")
            } else {
                out[w.number] = Verdict(kind: .auxiliary, why: app.launchedByMargin || app.hosted.isEmpty ? "another window of its app (\(size(w.bounds)))" : "another window of an app the person opened (\(size(w.bounds)))")
            }
        }
        return out
    }

    // The main window among `pool` when Margin hosts none of them (or its app replaced it), and the criterion that told
    // it from the next one.
    private static func best(of pool: [Window], app: App) -> (Window, String)? {
        guard let first = pool.first else { return nil }
        guard pool.count > 1 else { return (first, "its app's only window that could be main") }
        let criteria: [(String, (Window) -> Double)] = [
            ("the one in a Space", { $0.place.placed || $0.onScreen == true ? 1 : 0 }),
            ("Accessibility's main window", { $0.axMain ? 1 : 0 }),
            ("the one on screen", { $0.onScreen == true && $0.alpha > 0 ? 1 : 0 }),
            ("main before", { app.previousMains.contains($0.number) ? 1 : 0 }),
            ("Accessibility's focused window", { $0.axFocused ? 1 : 0 }),
            ("not minimized", { $0.minimized == true ? 0 : 1 }),
            ("a standard window", { $0.subrole == "AXStandardWindow" ? 1 : 0 }),
            ("the bigger", { Double($0.bounds.width * $0.bounds.height) }),
            ("the newer", { Double($0.number) }),
        ]
        func before(_ a: Window, _ b: Window) -> Bool {
            for (_, key) in criteria where key(a) != key(b) { return key(a) > key(b) }
            return false
        }
        let sorted = pool.sorted(by: before)
        let (winner, next) = (sorted[0], sorted[1])
        let why = criteria.first { $0.1(winner) != $0.1(next) }?.0 ?? "the first"
        return (winner, why + " (of \(pool.count))")
    }
}
