// Which window server window is which of the extension's windows (PLAN.md
// §5): by bounds (windows.get's left, top, width, height against the window
// server's, both from the top left of the main display), with focus and
// being on screen to break ties: two full-screen windows have the same
// bounds, but only the one in the Space showing is on screen, and the
// browser's focused window is its frontmost one on screen. A window matched
// before keeps its match when nothing else tells them apart.
//
// Also: whether an overlay is stacked just above its browser window, from the
// same list (re-ordered if not).

import CoreGraphics
import Foundation

// One of an extension copy's windows: its link (Hello.key) and its id there.
nonisolated struct WindowKey: Hashable, Comparable, CustomStringConvertible {
    let link: String
    let windowId: Int
    static func < (a: WindowKey, b: WindowKey) -> Bool { (a.link, a.windowId) < (b.link, b.windowId) }
    var description: String { "\(link)#\(windowId)" }
}

// A window as the extension reports it (`windows`, app/PROTOCOL.md).
struct ExtWindow: Equatable {
    let key: WindowKey
    let bounds: CGRect?
    let state: String // normal, fullscreen, maximized, minimized
    let focused: Bool
    let activeTabId: Int?

    static func parse(_ list: [JSONObject], link: String) -> [ExtWindow] {
        list.compactMap { w in
            guard let id = int(w["windowId"] ?? w["id"]) else { return nil }
            var bounds: CGRect?
            if let l = num(w["left"]), let t = num(w["top"]), let width = num(w["width"]), let height = num(w["height"]), width > 0, height > 0 {
                bounds = CGRect(x: l, y: t, width: width, height: height)
            }
            return ExtWindow(key: WindowKey(link: link, windowId: id), bounds: bounds, state: w["state"] as? String ?? "normal",
                             focused: w["focused"] as? Bool ?? false, activeTabId: int(w["activeTabId"]))
        }
    }
}

enum WindowMatcher {
    // How far each edge may be off (points): browsers round, and a window being animated lags a poll.
    static let tolerance: CGFloat = 8
    // The smallest window that can be a browser window (not a popover, a sheet, a tooltip).
    static let minSize: CGFloat = 120

    static func close(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = tolerance) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance && abs(a.maxX - b.maxX) <= tolerance && abs(a.maxY - b.maxY) <= tolerance
    }

    static func distance(_ a: CGRect, _ b: CGRect) -> CGFloat {
        abs(a.minX - b.minX) + abs(a.minY - b.minY) + abs(a.width - b.width) + abs(a.height - b.height)
    }

    // The browser's windows a match can be: normal ones (layer 0), drawn, browser-sized.
    static func candidates(_ server: [ServerWindow], pids: Set<pid_t>) -> [ServerWindow] {
        server.filter { pids.contains($0.pid) && $0.layer == 0 && $0.alpha > 0 && $0.bounds.width >= minSize && $0.bounds.height >= minSize }
    }

    /// Each extension window to the number of the window server window it is.
    /// `pids`: the browser's processes; `browserInFront`: the browser is the
    /// active app (only then does `focused` say which window is in front);
    /// `previous`: the last matches.
    static func match(ext: [ExtWindow], server: [ServerWindow], pids: Set<pid_t>, browserInFront: Bool,
                      previous: [WindowKey: Int] = [:], tolerance: CGFloat = tolerance) -> [WindowKey: Int] {
        let windows = candidates(server, pids: pids)
        let front = windows.filter(\.onScreen).min { $0.order < $1.order }?.number
        struct Pair { let key: WindowKey; let number: Int; let cost: Double }
        var pairs: [Pair] = []
        for e in ext where e.state != "minimized" {
            guard let bounds = e.bounds else { continue }
            for w in windows where close(bounds, w.bounds, tolerance: tolerance) {
                var cost = Double(distance(bounds, w.bounds))
                // Focus first (when it means anything), then the match before, then being on screen.
                if browserInFront && e.focused != (w.number == front) { cost += 1_000_000 }
                if let before = previous[e.key], before != w.number { cost += 10_000 }
                if previous[e.key] == nil, previous.values.contains(w.number) { cost += 10_000 }
                if !w.onScreen { cost += 1_000 }
                pairs.append(Pair(key: e.key, number: w.number, cost: cost))
            }
        }
        // Cheapest first; equal costs in a fixed order, so the same input gives the same matches.
        pairs.sort { ($0.cost, $0.key, $0.number) < ($1.cost, $1.key, $1.number) }
        var out: [WindowKey: Int] = [:]
        var taken = Set<Int>()
        for p in pairs where out[p.key] == nil && !taken.contains(p.number) {
            out[p.key] = p.number
            taken.insert(p.number)
        }
        return out
    }

    /// Whether `overlay` is just above `browser` in the window server's list:
    /// both on screen, the overlay nearer the front, and no other normal or
    /// higher window (any app's, another overlay) between them.
    static func stackedAbove(_ list: [ServerWindow], overlay: Int, browser: Int) -> Bool {
        let shown = list.filter(\.onScreen).sorted { $0.order < $1.order }
        guard let o = shown.firstIndex(where: { $0.number == overlay }), let b = shown.firstIndex(where: { $0.number == browser }), o < b else { return false }
        let browserPid = shown[b].pid
        // The browser's own small windows (a popover above its window) don't count.
        return !shown[(o + 1)..<b].contains { $0.layer >= 0 && $0.alpha > 0 && !($0.pid == browserPid && $0.layer > 0) && $0.bounds.intersects(shown[b].bounds) }
    }
}
