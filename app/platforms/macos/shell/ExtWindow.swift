// A copy's windows as its extension reports them (`windows`, docs/PROTOCOL.md): which of Safari's windows the session
// knows (HostedSession.swift: the windows a copy restored, the one Margin asked for).

import CoreGraphics
import Foundation

// One of an extension copy's windows: its link (Hello.key) and its id there.
nonisolated struct WindowKey: Hashable, Comparable, CustomStringConvertible {
    let link: String
    let windowId: Int
    static func < (a: WindowKey, b: WindowKey) -> Bool { (a.link, a.windowId) < (b.link, b.windowId) }
    var description: String { "\(link)#\(windowId)" }
}

struct ExtWindow: Equatable {
    let key: WindowKey
    let bounds: CGRect?
    let state: String // normal, fullscreen, maximized, minimized
    let focused: Bool
    let activeTabId: Int?
    // Seconds since 1970 (the copy's Date.now(), the same clock as the app's): when its copy last heard
    // windows.onFocusChanged name it, and windows.onCreated (nil: not heard since the copy started).
    var focusedAt: Double?
    var createdAt: Double?

    static func parse(_ list: [JSONObject], link: String) -> [ExtWindow] {
        list.compactMap { w in
            guard let id = int(w["windowId"] ?? w["id"]) else { return nil }
            var bounds: CGRect?
            if let l = num(w["left"]), let t = num(w["top"]), let width = num(w["width"]), let height = num(w["height"]), width > 0, height > 0 {
                bounds = CGRect(x: l, y: t, width: width, height: height)
            }
            let ms = { (v: Any?) in num(v).flatMap { $0 > 0 ? $0 / 1000 : nil } }
            return ExtWindow(key: WindowKey(link: link, windowId: id), bounds: bounds, state: w["state"] as? String ?? "normal",
                             focused: w["focused"] as? Bool ?? false, activeTabId: int(w["activeTabId"]),
                             focusedAt: ms(w["focusedAt"]), createdAt: ms(w["createdAt"]))
        }
    }
}
