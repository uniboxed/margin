// What Margin's extension and Margin.app say on their link, version 2 (docs/PROTOCOL.md describes every message and
// the order they come in), as the rest of the app reads it. The words themselves are margin-core's
// (app/shared/core/src/protocol.rs: each message read, checked and written, the 1 MB cap on what the app sends; the
// link's session and its WebSocket in link.rs, socket.rs, websocket.rs, relay.rs, joined in link_hub.rs; docs/
// CORE-REFACTOR.md step 1.5): a message comes here already read by the core (`LinkMessage(core:)` maps its JSON, with
// nothing checked twice), and what the app sends goes to the core as `{ k, … }` (`AppMessage.core`), stamped and
// sized there. A copy's state (its snapshot, deltas and window lists) is the core's too, applied as it's read
// (mirror.rs, link_hub.rs): what comes here is what each did (`State`), the values read through StateMirror.swift.

import CoreGraphics
import Foundation
import MarginCore

typealias JSONObject = [String: Any]

// A number in JSON (JSONSerialization gives NSNumber; a Bool is not one).
func num(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n.doubleValue
}

func int(_ v: Any?) -> Int? {
    guard let d = num(v), d.rounded() == d, abs(d) < 9e15 else { return nil }
    return Int(d)
}

// Any JSON value as text (a string, a number or null too).
func jsonText(_ value: Any) -> Data? {
    try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
}

func jsonString(_ value: Any) -> String? {
    jsonText(value).flatMap { String(data: $0, encoding: .utf8) }
}

// margin-ffi's calls with JSON in and out (the link's, ExtensionLink.swift, and the protocol's with no object).
enum LinkCore {
    // A JSON answer of one of the calls (freed here), nil if there's none.
    static func answer(_ call: (UnsafeMutablePointer<Int>) -> UnsafeMutablePointer<UInt8>?) -> Any? {
        var len = 0
        guard let out = call(&len) else { return nil }
        defer { margin_buffer_free(out, len) }
        return try? JSONSerialization.jsonObject(with: Data(bytes: out, count: len), options: [.fragmentsAllowed])
    }

    // `request` (a JSON object) to a call taking its bytes; nil if it isn't JSON (JSONSerialization's check first: it
    // raises rather than throws on what it can't write).
    static func call(_ request: JSONObject, _ call: (UnsafePointer<UInt8>?, Int, UnsafeMutablePointer<Int>) -> UnsafeMutablePointer<UInt8>?) -> Any? {
        guard JSONSerialization.isValidJSONObject(request), let data = jsonText(request) else { return nil }
        return data.withUnsafeBytes { raw in
            answer { call(raw.bindMemory(to: UInt8.self).baseAddress, raw.count, $0) }
        }
    }

    // The protocol's builders and readers (margin_link_protocol): no object.
    static func protocolCall(_ request: JSONObject) -> Any? {
        call(request) { margin_link_protocol($0, $1, $2) }
    }

    static let constants = protocolCall(["type": "constants"]) as? JSONObject ?? [:]
}

enum LinkProtocol {
    static let version = int(LinkCore.constants["version"]) ?? 2
    // The largest message the app sends, as UTF-8 JSON (the core refuses a bigger one).
    static let maxAppMessage = int(LinkCore.constants["maxAppMessage"]) ?? 1_000_000
}

enum LinkMessage {
    struct Hello: Equatable {
        let epoch: String
        let profile: String // the browser profile this copy runs in (one link per profile)
        let browser: String // "safari", "chrome", "edge"
        let ext: String? // the extension's version
        let owner: Bool // the copy in charge of the state in its profile
        let instanceId: String?
        let origin: String? // the copy whose ids the state has
        let since: Double?
        let pid: Int? // the browser's process, if the copy knows it (Chrome's relay helper does)
        // What the copy says of a time its link was off (its socket guard, background/link.ts), for the log.
        var socketsOff: String? = nil

        // The link's key: one link per browser profile.
        var key: String { "\(browser):\(profile)" }

        // As the core read it (protocol.rs Hello::object).
        init?(core h: JSONObject) {
            guard let epoch = h["epoch"] as? String, let profile = h["profile"] as? String, let browser = h["browser"] as? String else { return nil }
            self.init(epoch: epoch, profile: profile, browser: browser, ext: h["ext"] as? String, owner: h["owner"] as? Bool == true,
                      instanceId: h["instanceId"] as? String, origin: h["origin"] as? String, since: num(h["since"]), pid: int(h["pid"]),
                      socketsOff: h["socketsOff"] as? String)
        }

        init(epoch: String, profile: String, browser: String, ext: String?, owner: Bool, instanceId: String?, origin: String?, since: Double?, pid: Int?, socketsOff: String? = nil) {
            (self.epoch, self.profile, self.browser, self.ext, self.owner) = (epoch, profile, browser, ext, owner)
            (self.instanceId, self.origin, self.since, self.pid, self.socketsOff) = (instanceId, origin, since, pid, socketsOff)
        }
    }

    // A snapshot, a delta or a window list, as the core applied it to the link's state (link_hub.rs StateApplied).
    struct State {
        enum Kind: String { case snapshot, delta, windows }
        enum Outcome: Equatable {
            case applied
            case ignored // another epoch's, or the state is being asked for again (a resync)
            case gap(expected: Int, got: Int) // a number missed: the state asked for again (logged and sent by the core)
        }

        let kind: Kind
        let epoch: String
        let seq: Int
        let outcome: Outcome
        let keys: Set<String> // the keys it carried: a snapshot's state's, a delta's changes'
        let windows: [JSONObject]? // the windows, when it changed them
        let hasState: Bool
        let resyncing: Bool

        init?(core s: JSONObject) {
            guard let kind = (s["kind"] as? String).flatMap(Kind.init(rawValue:)) else { return nil }
            self.kind = kind
            epoch = s["epoch"] as? String ?? ""
            seq = int(s["seq"]) ?? 0
            switch s["outcome"] as? String {
            case "applied": outcome = .applied
            case "gap": outcome = .gap(expected: int(s["expected"]) ?? 0, got: int(s["got"]) ?? 0)
            default: outcome = .ignored
            }
            keys = Set(s["keys"] as? [String] ?? [])
            windows = s["windows"] as? [JSONObject]
            hasState = s["hasState"] as? Bool == true
            resyncing = s["resyncing"] as? Bool == true
        }
    }

    // A theme package put together from its pieces by the core (link_hub.rs), or why not (already logged there).
    enum Theme {
        case complete(id: String, data: Data)
        case refused(String)
    }

    case hello(Hello)
    // The copy's state changed (or a message of it was left): the core's mirror has it (the link's `mirror`).
    case state(State)
    // Something for one window's UI (or every window's, with no windowId). The app reads `loading` and the preview's
    // and the UI's pushes (Shell.linkReceived).
    case push(epoch: String, windowId: Int?, msg: JSONObject)
    case theme(epoch: String, theme: Theme)
    // The copy's shortcuts for the app's hot keys: { command: [combination] } (Shortcuts.swift).
    case keys(epoch: String, bindings: [String: [String]])
    case reply(id: Int, body: JSONObject)
    case tock
    case bye(why: String)
    // The lasting data (docs/DATA.md "Messages": data.hello, data.snapshot, data.changes), as it came.
    case data(kind: String, body: JSONObject)
    // A kind this app doesn't know (a newer extension): left.
    case other(String)

    // A message as the core read it (protocol.rs LinkMessage::object: its wire form, every field checked there).
    init?(core m: JSONObject) {
        guard let k = m["k"] as? String else { return nil }
        if k.hasPrefix("data.") { self = .data(kind: k, body: m); return }
        let epoch = m["epoch"] as? String ?? ""
        switch k {
        case "hello":
            guard let h = Hello(core: m) else { return nil }
            self = .hello(h)
        case "push":
            self = .push(epoch: epoch, windowId: int(m["windowId"]), msg: m["msg"] as? JSONObject ?? [:])
        case "keys":
            var bindings: [String: [String]] = [:]
            for (command, list) in m["bindings"] as? JSONObject ?? [:] { bindings[command] = list as? [String] ?? [] }
            self = .keys(epoch: epoch, bindings: bindings)
        case "reply":
            var body = m
            body["k"] = nil
            body["id"] = nil
            self = .reply(id: int(m["id"]) ?? 0, body: body)
        case "tock":
            self = .tock
        case "bye":
            self = .bye(why: m["why"] as? String ?? "")
        default:
            // (A snapshot, a delta or a window list never comes here on a link: the core applies it and says `State`.)
            self = .other(k)
        }
    }

    // A message's text read by the core (the tests'): nil if it isn't one.
    static func decode(_ text: String) -> LinkMessage? { read(text).flatMap { LinkMessage(core: $0) } }

    // A message's text as the core reads it (protocol.rs LinkMessage::object), its fields checked: nil if it isn't one.
    static func read(_ text: String) -> JSONObject? { LinkCore.protocolCall(["type": "message", "text": text]) as? JSONObject }
}

// What the app sends a copy (its link's session's own, welcome, tick, req and bye, are the core's).
enum AppMessage {
    case resync(epoch: String)
    // Whether Margin draws that window of the copy's: true only for the Safari window it hosts (Shell.tellDrawn).
    case drawn(epoch: String, windowId: Int, on: Bool)
    // The lasting data (docs/DATA.md "Messages": data.need, data.snapshot, data.changes, data.ack).
    case data(kind: String, body: JSONObject)

    // As the core takes it: `{ k, … }` (`at` stamped there).
    var core: JSONObject {
        switch self {
        case .resync(let epoch): return ["k": "resync", "epoch": epoch]
        case .drawn(let epoch, let windowId, let on): return ["k": "drawn", "epoch": epoch, "windowId": windowId, "on": on]
        case .data(let kind, let body): return body.merging(["k": kind]) { $1 }
        }
    }

    // The message's text as the core writes it now; nil if it isn't JSON or would be over 1 MB (the tests').
    func encode() -> String? {
        (LinkCore.protocolCall(["type": "encode", "message": core, "at": (Date().timeIntervalSince1970 * 1000).rounded()]) as? JSONObject)?["text"] as? String
    }
}

// ---- Requests to a copy about its windows, and their answers (docs/PROTOCOL.md): the core's (protocol.rs) ----

// A window request to a copy with a deadline (the hosted Safari window into full screen or out of it:
// HostedSession.safariFullScreen), as a `req`'s type and payload. `notAfter` is milliseconds since 1970 (the app and
// its copies read the same clock): a copy that gets the request after it makes no windows call and answers
// { refused: 'late' }.
enum HandoffRequest {
    enum State: String { case fullscreen, normal }

    // A window to full screen and focused, or to normal without taking focus. Answered as soon as Safari took the ask
    // (`land: false`): what the window did is read from the window server (HostEngine), never from Safari's word.
    case setWindowState(windowId: Int, state: State, focused: Bool = false, notAfter: Double)

    private var built: JSONObject {
        switch self {
        case .setWindowState(let id, let state, let focused, let notAfter):
            return LinkCore.protocolCall(["type": "setWindowState", "windowId": id, "state": state.rawValue, "focused": focused, "notAfter": notAfter, "land": false]) as? JSONObject ?? [:]
        }
    }

    var type: String { built["type"] as? String ?? "setWindowState" }
    var payload: JSONObject { built["payload"] as? JSONObject ?? [:] }
}

// What a windows call answered (setWindowState, closeWindow: the reply's `result`), as the core read it.
// `busy` and `refused` mean the copy made no windows call: nothing changed, and a `busy` is evidence
// that an earlier call for that window is stuck (behind a hung tab).
enum WindowCallAnswer: Equatable {
    case asked(windowId: Int, state: String) // setWindowState with `land: false`: Safari took the ask (no word on the state)
    case landed(windowId: Int, state: String, at: Double) // setWindowState: Safari says the window is in that state (landedAt)
    case timedOut(windowId: Int, state: String) // setWindowState: asked, not in that state within 3 s
    case busy // another windows call for that window was still pending
    case refused(why: String, pastMs: Double?) // `late`: it came past its notAfter (by pastMs)
    case done(state: String?) // closeWindow's answer (nothing)

    init(_ result: JSONObject) {
        let a = LinkCore.protocolCall(["type": "windowCall", "result": result]) as? JSONObject ?? [:]
        let id = int(a["windowId"]) ?? 0
        let state = a["state"] as? String ?? ""
        switch a["answer"] as? String {
        case "asked": self = .asked(windowId: id, state: state)
        case "landed": self = .landed(windowId: id, state: state, at: num(a["at"]) ?? 0)
        case "timedOut": self = .timedOut(windowId: id, state: state)
        case "busy": self = .busy
        case "refused": self = .refused(why: a["why"] as? String ?? "", pastMs: num(a["pastMs"]))
        default: self = .done(state: a["state"] as? String)
        }
    }

    // Whether the copy called Safari for it.
    var called: Bool {
        switch self {
        case .busy, .refused: false
        case .asked, .landed, .timedOut, .done: true
        }
    }
}

// What newWindow answered: the new window, and its bounds as Safari gave them (points from the top left of
// the main display, as the windows list has them), as the core read it. An older copy sends no bounds.
struct SpaceWindowAnswer: Equatable {
    let windowId: Int
    let bounds: CGRect?

    init?(_ result: JSONObject) {
        guard let a = LinkCore.protocolCall(["type": "spaceWindow", "result": result]) as? JSONObject, let windowId = int(a["windowId"]) else { return nil }
        self.windowId = windowId
        if let b = a["bounds"] as? JSONObject, let x = num(b["x"]), let y = num(b["y"]), let w = num(b["width"]), let h = num(b["height"]) {
            bounds = CGRect(x: x, y: y, width: w, height: h)
        } else {
            bounds = nil
        }
    }
}
