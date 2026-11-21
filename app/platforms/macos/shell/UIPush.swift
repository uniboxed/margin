// The pushes of a browser's copy (its `push { windowId, msg }`, docs/PROTOCOL.md) that reach a Margin window's page:
// only the types listed here, and of each only the fields listed, each checked and cut to its size (never the copy's
// JSON as it came). A copy's tab is never named to the page by its own id: by the UI's number for the item it shows
// (HostedSession.number(ofItem:)), and an entry whose tab isn't one of Margin's items is dropped. Which Margin window
// gets it: HostedSession.copyPush.
//
// A new one is one line of `forwarded`: its type and its fields (and, for a push that says what is now rather than
// that something happened, its type in `standing` too: taken back from a window that no longer gets it).
// Peek's pushes (`peekOpen`, `peekCancel`, `cardPage`, `cardKey`) are not UI pushes: the session acts on them
// (Shell.linkReceived → HostedPeek.swift), answers a click at once, and tells the page what the card is itself.

import Foundation

indirect enum PushField {
    case text(Int) // a string, at most that many characters ("" when not one)
    case webURL // an http(s) address, at most 2048 characters (null when not one)
    case image // an image data URL (PNG, JPEG, WebP, GIF; base64; at most 128 KB, the UI's own limit), else null
    case flag // true or false (false when not one)
    case time // a time in ms since 1970 (0 when not one)
    case optionalTime // …or null
    case tab // the copy's tab: the UI's number for its item; not one of Margin's items: the entry is dropped
    case list(Int, [String: PushField]) // at most that many objects, each with these fields
}

enum UIPush {
    static let forwarded: [String: [String: PushField]] = [
        // The background mini player's sources for one of the copy's windows (background/media.ts, M2.4).
        "media": ["sources": .list(8, ["tabId": .tab, "title": .text(140), "subtitle": .text(100), "artwork": .image, "playing": .flag, "muted": .flag,
                                       "canPrev": .flag, "canNext": .flag, "updatedAt": .time, "pausedAt": .optionalTime])],
        // A word of Margin's in the theme's toast (overlay.ts `toast`).
        "toast": ["text": .text(140)],
    ]
    // The pushes that say what is now (the window they were last given to gets the empty one when another gets it).
    static let standing: Set<String> = ["media"]

    static let imageLimit = 128 * 1024
    private static let image = try! NSRegularExpression(pattern: #"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$"#)

    // The push as the page gets it, or nil: not a type passed on. `tab`: the UI's number for a copy's tab, given the
    // whole entry it's in (its `tabId`, `itemId`, `url`), nil when it isn't one of Margin's items.
    static func page(_ msg: JSONObject, tab: (JSONObject) -> Int?) -> JSONObject? {
        guard let type = msg["type"] as? String, let fields = forwarded[type] else { return nil }
        var out = object(msg, fields, tab: tab) ?? [:]
        out["type"] = type
        return out
    }

    // The empty push of a standing type (its lists empty, its flags false): what a window no longer given it gets.
    static func empty(_ type: String) -> JSONObject? {
        guard standing.contains(type) else { return nil }
        return page(["type": type], tab: { _ in nil })
    }

    private static func object(_ raw: JSONObject, _ fields: [String: PushField], tab: (JSONObject) -> Int?) -> JSONObject? {
        var out: JSONObject = [:]
        for (key, field) in fields {
            if case .tab = field {
                guard let n = tab(raw) else { return nil }
                out[key] = n
            } else {
                out[key] = value(raw[key], field, tab: tab)
            }
        }
        return out
    }

    private static func value(_ v: Any?, _ field: PushField, tab: (JSONObject) -> Int?) -> Any {
        switch field {
        case .text(let max):
            return String((v as? String ?? "").prefix(max))
        case .webURL:
            guard let s = v as? String, s.count <= 2048, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return NSNull() }
            return s
        case .image:
            guard let s = v as? String, s.utf8.count <= imageLimit,
                  image.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil else { return NSNull() }
            return s
        case .flag:
            return v as? Bool ?? false
        case .time:
            return finiteTime(v) ?? 0
        case .optionalTime:
            return finiteTime(v) ?? NSNull()
        case .tab:
            return NSNull() // (an object's: `object`)
        case .list(let max, let fields):
            // (Read no further than twice as many as are passed: a copy's list never costs more than that.)
            let raw = (v as? [Any] ?? []).prefix(max * 2).compactMap { $0 as? JSONObject }
            return Array(raw.compactMap { object($0, fields, tab: tab) }.prefix(max))
        }
    }

    private static func finiteTime(_ v: Any?) -> Double? {
        guard let d = num(v), d.isFinite, d >= 0, d < 1e15 else { return nil }
        return d.rounded()
    }
}
