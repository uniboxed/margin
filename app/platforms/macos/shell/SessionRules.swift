// The session's pure rules, margin-core's (app/shared/core/src/session/, through margin-ffi's session_rules.rs;
// docs/CORE-REFACTOR.md step 3, commit 1): a split's room, a drag's line, the card's default rect, a web address, a
// web item's profile, the item a window showed last and its loader's app, a search's address, the copies' pushes for
// the page, the page's layout report. The Swift that asked them keeps its names (HostedSession, HostedPeek, UIPush,
// PageLayout); what it decided is the core's. The rare ones are one JSON call each; a split's room, the card's rect
// and a web address are typed.

import CoreGraphics
import Foundation
import MarginCore

enum SessionRules {
    // One rare rule: `{ rule, … }` → its answer ([:] if there's none).
    nonisolated static func call(_ request: JSONObject) -> JSONObject {
        KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_session_rule(p, n, $0) } } as? JSONObject ?? [:]
    }

    nonisolated static let constants: JSONObject = call(["rule": "constants"])

    // A web address (the core's rule), and for a host with letters outside ASCII the OS's IDNA (UTS #46, ICU's, as
    // Foundation runs it): whether it makes a valid ASCII name of the host, which only Foundation's `URL` can say here.
    nonisolated static func webAddress(_ s: String) -> Bool {
        var at = 0, len = 0
        let utf8 = Array(s.utf8)
        let said = utf8.withUnsafeBufferPointer { margin_web_address($0.baseAddress, $0.count, &at, &len) }
        guard said == 2 else { return said == 1 }
        guard at >= 0, len >= 0, at + len <= utf8.count, let host = String(bytes: utf8[at..<(at + len)], encoding: .utf8) else { return false }
        return idna(host)
    }
    // ...the OS's IDNA's answer for such a host (the session's `idna` port too).
    nonisolated static func idna(_ host: String) -> Bool { URL(string: "http://\(host)/") != nil }

    // JSON for the core of what a page or a copy said (a WKScriptMessage's objects, JSONSerialization's): a number
    // that isn't finite is null (as the page's own JSON would say it), and anything JSON hasn't is null.
    nonisolated static func json(_ value: Any) -> Any {
        switch value {
        case let o as [String: Any]: return o.mapValues { json($0) }
        case let a as [Any]: return a.map { json($0) }
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n }
            return n.doubleValue.isFinite ? n : NSNull()
        case is String, is NSNull: return value
        default: return NSNull()
        }
    }
}
