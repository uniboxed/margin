// A copy's windows as its extension reports them (`windows`, docs/PROTOCOL.md): which of Safari's windows the session
// knows (HostedSession.swift: the windows a copy restored, the one Margin asked for), and which the copy is told
// Margin draws (Shell.tellDrawn).

import Foundation

struct ExtWindow: Equatable {
    let id: Int // the copy's id for it
    let state: String // normal, fullscreen, maximized, minimized
    // Seconds since 1970 (the copy's Date.now(), the same clock as the app's): when its copy heard windows.onCreated
    // for it (nil: not heard since the copy started, a window Safari restored).
    var createdAt: Double?

    static func parse(_ list: [JSONObject]) -> [ExtWindow] {
        list.compactMap { w in
            guard let id = int(w["windowId"] ?? w["id"]) else { return nil }
            return ExtWindow(id: id, state: w["state"] as? String ?? "normal", createdAt: num(w["createdAt"]).flatMap { $0 > 0 ? $0 / 1000 : nil })
        }
    }
}
