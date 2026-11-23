// The pushes of a browser's copy (its `push { windowId, msg }`, docs/PROTOCOL.md) that reach a Margin window's page:
// only the types the core passes on, and of each only its fields, each checked and cut to its size (never the copy's
// JSON as it came): the core's rule (app/shared/core/src/session/push.rs, its table of types and fields). A copy's tab
// is never named to the page by its own id: by the UI's number for the item it shows (HostedSession.number(ofItem:)),
// and an entry whose tab isn't one of Margin's items is dropped. Which Margin window gets it: HostedSession.copyPush.
// The preview's pushes (`peekOpen`, `peekCancel`, `cardPage`, `cardKey`) are not UI pushes: the session acts on them
// (Shell.linkReceived → HostedPeek.swift), answers a click at once, and tells the page what the card is itself.

import Foundation
import MarginCore

enum UIPush {
    // The types passed on, and those that say what is now (the window they were last given to gets the empty one when
    // another gets it).
    nonisolated static let forwarded = Set((SessionRules.constants["pushForwarded"] as? [Any] ?? []).compactMap { $0 as? String })
    nonisolated static let standing = Set((SessionRules.constants["pushStanding"] as? [Any] ?? []).compactMap { $0 as? String })
    nonisolated static let imageLimit = (SessionRules.constants["imageLimit"] as? NSNumber)?.intValue ?? 0

    // The push as the page gets it, or nil: not a type passed on. `tab`: the UI's number for a copy's tab, given the
    // whole entry it's in (its `tabId`, `itemId`, `url`), nil when it isn't one of Margin's items (asked once for each
    // entry read, in their order).
    static func page(_ msg: JSONObject, tab: (JSONObject) -> Int?) -> JSONObject? {
        withoutActuallyEscaping(tab) { tab in
            var asking = tab
            return withUnsafeMutablePointer(to: &asking) { ctx in
                let out = KeysCore.bytes(KeysCore.json(SessionRules.json(msg))) { p, n in
                    KeysCore.answer { margin_push_page(p, n, ctx, { ctx, entry, len in
                        guard let ctx, let entry, let o = (try? JSONSerialization.jsonObject(with: Data(bytes: entry, count: len))) as? [String: Any] else { return -1 }
                        return Int64(ctx.assumingMemoryBound(to: ((JSONObject) -> Int?).self).pointee(o) ?? -1)
                    }, $0) }
                }
                return (out as? JSONObject)?["push"] as? JSONObject
            }
        }
    }

    // The empty push of a standing type (its lists empty, its flags false): what a window no longer given it gets.
    static func empty(_ type: String) -> JSONObject? {
        SessionRules.call(["rule": "pushEmpty", "type": type])["push"] as? JSONObject
    }
}
