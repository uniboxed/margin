// The hosting core's window kinds (docs/HOSTING-CORE.md, principle 2): every window of an app Margin hosts gets one
// kind from generic rules on its layer, size, position, Accessibility's role and subrole, and its history. Never a
// bundle id. The rules are the hosting core's (margin-core, Rust: app/shared/core/src/host/kinds.rs, tested there,
// a row per case the real sessions showed); this file keeps the values the engine and the observer pass around and
// asks the core (HostCore.swift). The kinds:
//   main       the window that is the app (shown at the page area, or parked): one per host
//   auxiliary  settings, inspectors, floating panels, the app's other windows (a second document, the person's own)
//   dialog     alerts and sheets (shown on top of the main window)
//   strip      a full-screen window's toolbar or title band: the page area's width at least, at most 150 pt tall
//   leftover   restored from an earlier session, or opened by Margin only to wake something: to be closed or parked
//   helper     its app's answer to Margin sizing it: a new window at the size Margin just set (Weather's 1264×966
//              window for 0.2 s after each tile resize, 2026-11-18 13:30): never shown, adopted, parked, let in front
//              or reacted to
//   transient  menus, tooltips, popovers, spares never ordered in, a twin at the main window's frame, a hosted
//              window its app replaced: nothing to do with them

import AppKit
import MarginCore

nonisolated enum WindowKind: String, Sendable, Codable, CaseIterable {
    case main, auxiliary, dialog, strip, leftover, helper, transient

    // Kept behind Margin's window and never acted on as the app's own.
    var keptBehind: Bool { self == .leftover || self == .strip || self == .transient || self == .helper }
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
        var firstSeen: Double? = nil // when Margin first saw it (the engine's clock)
    }

    // What Margin knows of the app: whether it started it, the windows it hosts, the ones it opened only to wake it, and
    // the windows that were main (and helpers) at the last classification.
    struct App: Equatable, Sendable {
        var launchedByMargin = false
        var hosted: Set<Int> = []
        var woken: Set<Int> = []
        var previousMains: Set<Int> = []
        var previousHelpers: Set<Int> = []
        // Its windows as the first show of the window Margin hosts ended (an app Margin started).
        var launchWindows: Set<Int> = []
        // Its windows Accessibility said were destroyed (closed) that the window server still lists.
        var closed: Set<Int> = []
        // The last time Margin sized one of its windows (a tile's rect, a frame) and the rects it set.
        var resized: Resized? = nil
        // Its hosts laid out at rects of their own (a card's, a split pane's): each one's toolbar a strip of its rect.
        var hostRects: [CGRect] = []
    }

    // Margin's last sizing of an app's window: when, and the rects it set (a tile's, the window's frame).
    struct Resized: Equatable, Sendable {
        var at: Double
        var rects: [CGRect]
    }

    struct Verdict: Equatable, Sendable {
        let kind: WindowKind
        let why: String
    }

    static var tinySide: CGFloat { CGFloat(HostCore.shared.constant("tinySide") ?? 100) }
    static var stripMaxHeight: CGFloat { CGFloat(HostCore.shared.constant("stripMaxHeight") ?? 150) }

    // The page area's width at least (the display's for one that went full screen on its own), at most 150 pt tall.
    // Nothing to measure against (no placement yet): no strip.
    static func isStrip(_ b: CGRect, in p: HostPlacement) -> Bool {
        var pl = p.margin
        return margin_kinds_is_strip(b.marginRect, &pl)
    }
    // …or of one of its hosts' own rects (a card's or a pane's toolbar is as wide as its own window).
    static func isStrip(_ b: CGRect, in p: HostPlacement, rects: [CGRect]) -> Bool {
        isStrip(b, in: p) || rects.contains { isStrip(b, in: HostPlacement(page: $0, area: p.area, display: p.display)) }
    }

    static func near(_ a: CGRect, _ b: CGRect) -> Bool { HostLayout.near(a, b, within: 4) }

    // Each window's kind and why, by its number (the core's rules).
    static func classify(_ windows: [Window], app: App, in placement: HostPlacement) -> [Int: Verdict] {
        let answer = HostCore.shared.call(["type": "classify", "windows": windows.map(\.coreJSON), "app": app.coreJSON, "placement": placement.coreJSON])
        guard let verdicts = answer["verdicts"] as? [String: Any] else { return [:] }
        var out: [Int: Verdict] = [:]
        for (key, value) in verdicts {
            guard let n = Int(key), let v = value as? [String: Any], let k = (v["kind"] as? String).flatMap(WindowKind.init(rawValue:)) else { continue }
            out[n] = Verdict(kind: k, why: v["why"] as? String ?? "")
        }
        return out
    }
}

nonisolated extension WindowKinds.Window {
    var coreJSON: [String: Any] {
        var d: [String: Any] = ["number": number, "layer": layer, "bounds": bounds.coreJSON, "alpha": alpha, "place": place.coreName, "everPlaced": everPlaced,
                                "axMain": axMain, "axFocused": axFocused]
        if let onScreen { d["onScreen"] = onScreen }
        if let role { d["role"] = role }
        if let subrole { d["subrole"] = subrole }
        if let fullScreen { d["fullScreen"] = fullScreen }
        if let canFullScreen { d["canFullScreen"] = canFullScreen }
        if let minimized { d["minimized"] = minimized }
        if let firstSeen { d["firstSeen"] = firstSeen }
        return d
    }
}

nonisolated extension WindowKinds.App {
    var coreJSON: [String: Any] {
        var d: [String: Any] = ["launchedByMargin": launchedByMargin, "hosted": hosted.sorted(), "woken": woken.sorted(), "previousMains": previousMains.sorted(),
                                "previousHelpers": previousHelpers.sorted(), "launchWindows": launchWindows.sorted(), "closed": closed.sorted()]
        if let r = resized { d["resized"] = ["at": r.at, "rects": r.rects.map(\.coreJSON)] }
        if !hostRects.isEmpty { d["hostRects"] = hostRects.map(\.coreJSON) }
        return d
    }
}
