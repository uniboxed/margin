// What Margin's extension and Margin.app say on their link, version 2
// (app/PROTOCOL.md describes every message and the order they come in): one
// JSON object per message, `k` naming its kind. LinkMessage is what an
// extension copy sends, AppMessage what the app does. The state comes as the
// extension's stored values, left as they are (StateMirror keeps them).
//
// Grown from feat/native-panel's version 1: hello names the copy's browser
// and profile (each Safari profile runs its own copy, each with its own
// link), the panel's `cover` lease is gone, and the app sends `setLayout`
// (where the theme put the page, per window) and can send a `theme` in
// chunks. Nothing the app sends is over 1 MB (Chrome closes a native port on
// a bigger message from the app, PLAN.md §14): encode() refuses it.

import CoreGraphics
import Foundation

typealias JSONObject = [String: Any]

enum LinkProtocol {
    static let version = 2
    // The largest message the app sends, as UTF-8 JSON.
    static let maxAppMessage = 1_000_000
    // A chunk's bytes before base64 (about 683 KB as text, well inside maxAppMessage).
    static let chunkBytes = 512 * 1024
    // The largest theme taken in chunks (ui/theme-loader.js PACKAGE_LIMITS.storedBytes is 4.5 MB).
    static let maxThemeBytes = 8 * 1024 * 1024
}

// Where the theme put the page in one browser window (ui/host.js Geometry):
// `<m-page>`'s content box as insets from the window's edges, in points (CSS
// pixels at zoom 1 in the overlay, which is exactly over the window).
struct PageLayout: Equatable {
    var left: Double, top: Double, right: Double, bottom: Double
    var radius: Double
    var radii: [Double] // top-left, top-right, bottom-right, bottom-left
    var width: Double, height: Double // the overlay's (the window's) size it was measured at
    var mode: String

    // From the page's report ({ insets, radius, radii, container, mode }); nil if it isn't one.
    init?(geometry g: JSONObject) {
        guard let insets = g["insets"] as? JSONObject,
              let l = num(insets["left"]), let t = num(insets["top"]), let r = num(insets["right"]), let b = num(insets["bottom"]),
              let container = g["container"] as? JSONObject, let w = num(container["width"]), let h = num(container["height"]),
              [l, t, r, b, w, h].allSatisfy({ $0.isFinite }), w > 0, h > 0 else { return nil }
        let radius = num(g["radius"]) ?? 0
        let radii = (g["radii"] as? [Any])?.compactMap(num) ?? []
        self.init(left: l, top: t, right: r, bottom: b, radius: radius.isFinite ? max(0, radius) : 0,
                  radii: radii.count == 4 ? radii : [radius, radius, radius, radius], width: w, height: h,
                  mode: g["mode"] as? String ?? "fullscreen")
    }

    init(left: Double, top: Double, right: Double, bottom: Double, radius: Double, radii: [Double], width: Double, height: Double, mode: String) {
        (self.left, self.top, self.right, self.bottom, self.radius, self.radii, self.width, self.height, self.mode) = (left, top, right, bottom, radius, radii, width, height, mode)
    }

    // Measured in an overlay at `overlay` over a window at `window` (both top left): the insets from
    // the window's edges, as setLayout carries them. The overlay is the window, unless Safari takes
    // part of it (the docked Web Inspector: Shell.overlayFrame).
    func inWindow(overlay: CGRect, window: CGRect) -> PageLayout {
        guard overlay != window else { return self }
        return PageLayout(left: left + Double(overlay.minX - window.minX), top: top + Double(overlay.minY - window.minY),
                          right: right + Double(window.maxX - overlay.maxX), bottom: bottom + Double(window.maxY - overlay.maxY),
                          radius: radius, radii: radii, width: Double(window.width), height: Double(window.height), mode: mode)
    }

    // To half a point: what the page box can show (and what's compared before sending again).
    var rounded: PageLayout {
        let half = { (v: Double) in (v * 2).rounded() / 2 }
        return PageLayout(left: half(left), top: half(top), right: half(right), bottom: half(bottom), radius: half(radius),
                          radii: radii.map(half), width: half(width), height: half(height), mode: mode)
    }

    var object: JSONObject {
        ["insets": ["left": left, "top": top, "right": right, "bottom": bottom], "radius": radius, "radii": radii,
         "container": ["width": width, "height": height], "mode": mode]
    }
}

// A number in JSON (JSONSerialization gives NSNumber; a Bool is not one).
func num(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n.doubleValue
}

func int(_ v: Any?) -> Int? {
    guard let d = num(v), d.rounded() == d, abs(d) < 9e15 else { return nil }
    return Int(d)
}

// One piece of something too big for one message (a theme package): its
// bytes are the UTF-8 JSON of the whole, cut in order, each piece as base64.
struct Chunk: Equatable {
    let id: String // the theme's id
    let transfer: String // the whole's SHA-256, hex: which pieces belong together
    let part: Int // from 0
    let parts: Int
    let size: Int // the whole's bytes
    let data: String // this piece, base64

    init(id: String, transfer: String, part: Int, parts: Int, size: Int, data: String) {
        (self.id, self.transfer, self.part, self.parts, self.size, self.data) = (id, transfer, part, parts, size, data)
    }

    init?(_ m: JSONObject) {
        guard let id = m["id"] as? String, !id.isEmpty, id.count <= 64,
              let transfer = m["transfer"] as? String, transfer.count == 64,
              let part = int(m["part"]), let parts = int(m["parts"]), parts >= 1, parts <= 64, (0..<parts).contains(part),
              let size = int(m["size"]), size >= 0, let data = m["data"] as? String else { return nil }
        self.init(id: id, transfer: transfer, part: part, parts: parts, size: size, data: data)
    }

    var fields: JSONObject { ["id": id, "transfer": transfer, "part": part, "parts": parts, "size": size, "data": data] }
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
        // What the copy says of a time its link was off (its socket guard, background/link.js), for the log.
        var socketsOff: String? = nil

        // The link's key: one link per browser profile.
        var key: String { "\(browser):\(profile)" }
    }

    // A stored key in a delta: its new value, or gone.
    enum Change {
        case set(Any)
        case removed
    }

    struct Favicons {
        let set: JSONObject
        let del: [String]
    }

    case hello(Hello)
    case snapshot(epoch: String, seq: Int, state: JSONObject, windows: [JSONObject])
    case delta(epoch: String, seq: Int, changes: [String: Change], favicons: Favicons?)
    case windows(epoch: String, seq: Int, list: [JSONObject])
    // Something for one window's UI (or every window's, with no windowId): a notice, a switch under way.
    case push(epoch: String, windowId: Int?, msg: JSONObject)
    // A parked window used while it's out of sight (HANDOFF.md §6.1): a `push` of type parkedActivity,
    // taken out here because it's for the app, never for an overlay.
    case parkedActivity(epoch: String, ParkedActivity)
    case theme(epoch: String, chunk: Chunk)
    // The copy's shortcuts for the app's hot keys: { command: [combination] } (Shortcuts.swift).
    case keys(epoch: String, bindings: [String: [String]])
    case reply(id: Int, body: JSONObject)
    case tock
    case bye(why: String)
    // The lasting data (DATA.md "Messages": data.hello, data.snapshot, data.changes), as it came.
    case data(kind: String, body: JSONObject)
    // A kind this app doesn't know (a newer extension): left.
    case other(String)

    static let profilePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_.:-]{1,64}$")

    // nil: not a message (not JSON, or what its kind needs is missing).
    static func decode(_ text: String) -> LinkMessage? {
        guard let data = text.data(using: .utf8),
              let m = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject,
              let k = m["k"] as? String else { return nil }
        let epoch = m["epoch"] as? String
        let seq = int(m["seq"])
        if k.hasPrefix("data.") { return .data(kind: k, body: m) }
        switch k {
        case "hello":
            guard int(m["v"]) == LinkProtocol.version, let epoch, !epoch.isEmpty,
                  let profile = m["profile"] as? String,
                  profilePattern.firstMatch(in: profile, range: NSRange(profile.startIndex..., in: profile)) != nil,
                  let browser = m["browser"] as? String, ["safari", "chrome", "edge"].contains(browser) else { return nil }
            return .hello(Hello(epoch: epoch, profile: profile, browser: browser, ext: m["ext"] as? String, owner: m["owner"] as? Bool ?? false,
                                instanceId: m["instanceId"] as? String, origin: m["origin"] as? String, since: num(m["since"]), pid: int(m["pid"]),
                                socketsOff: (m["socketsOff"] as? String).map { String($0.prefix(200)) }))
        case "snapshot":
            guard let epoch, let seq, let state = m["state"] as? JSONObject else { return nil }
            return .snapshot(epoch: epoch, seq: seq, state: state, windows: m["windows"] as? [JSONObject] ?? [])
        case "delta":
            guard let epoch, let seq, let raw = m["changes"] as? JSONObject else { return nil }
            var changes: [String: Change] = [:]
            for (key, change) in raw {
                // storage.onChanged's { newValue }, with no newValue for a key removed.
                guard let change = change as? JSONObject else { return nil }
                changes[key] = change["newValue"].map(Change.set) ?? .removed
            }
            var favicons: Favicons?
            if let f = m["favicons"] as? JSONObject {
                favicons = Favicons(set: f["set"] as? JSONObject ?? [:], del: f["del"] as? [String] ?? [])
            }
            return .delta(epoch: epoch, seq: seq, changes: changes, favicons: favicons)
        case "windows":
            guard let epoch, let seq, let list = m["list"] as? [JSONObject] else { return nil }
            return .windows(epoch: epoch, seq: seq, list: list)
        case "push":
            guard let epoch, let msg = m["msg"] as? JSONObject else { return nil }
            if msg["type"] as? String == ParkedActivity.type {
                guard let activity = ParkedActivity(msg, windowId: int(m["windowId"])) else { return nil }
                return .parkedActivity(epoch: epoch, activity)
            }
            return .push(epoch: epoch, windowId: int(m["windowId"]), msg: msg)
        case "theme":
            guard let epoch, let chunk = Chunk(m) else { return nil }
            return .theme(epoch: epoch, chunk: chunk)
        case "keys":
            guard let epoch, let raw = m["bindings"] as? JSONObject else { return nil }
            var bindings: [String: [String]] = [:]
            for (command, list) in raw {
                guard let list = list as? [Any] else { continue }
                bindings[command] = list.compactMap { $0 as? String }.filter { $0.count <= 64 }.prefix(8).map { $0 }
            }
            return .keys(epoch: epoch, bindings: bindings)
        case "reply":
            guard let id = int(m["id"]) else { return nil }
            var body = m
            body["k"] = nil
            body["id"] = nil
            return .reply(id: id, body: body)
        case "tock":
            return .tock
        case "bye":
            return .bye(why: m["why"] as? String ?? "")
        default:
            return .other(k)
        }
    }
}

enum AppMessage {
    // First, on a socket the app accepted: the app's proof that it's the app.
    case welcome(key: String)
    case tick
    // An action from a window's UI, answered with `reply` (same id).
    case req(id: Int, epoch: String, windowId: Int?, type: String, payload: JSONObject)
    case resync(epoch: String)
    // Where the theme put the page in a window. `seq` counts up per window, per epoch.
    case setLayout(epoch: String, windowId: Int, seq: Int, layout: PageLayout)
    // Whether the app draws over a window (bound and wanted: Shell.swift DrawnOutbox). Only a change is sent.
    case drawn(epoch: String, windowId: Int, on: Bool)
    // Whether a window is parked: out of sight in its own private Space, alive (HANDOFF.md §2.5). The copy
    // keeps it per window, this epoch's only. Only a change is sent, like drawn.
    case parked(epoch: String, windowId: Int, on: Bool)
    case theme(epoch: String, chunk: Chunk)
    // The lasting data (DATA.md "Messages": data.need, data.snapshot, data.changes, data.ack).
    case data(kind: String, body: JSONObject)
    case bye(why: String)

    var object: JSONObject {
        let at = (Date().timeIntervalSince1970 * 1000).rounded()
        switch self {
        case .welcome(let key):
            return ["k": "welcome", "v": LinkProtocol.version, "key": key]
        case .tick:
            return ["k": "tick", "at": at]
        case .req(let id, let epoch, let windowId, let type, let payload):
            return ["k": "req", "id": id, "epoch": epoch, "at": at, "windowId": windowId ?? NSNull(), "type": type, "payload": payload]
        case .resync(let epoch):
            return ["k": "resync", "epoch": epoch]
        case .setLayout(let epoch, let windowId, let seq, let layout):
            return layout.object.merging(["k": "setLayout", "epoch": epoch, "windowId": windowId, "seq": seq, "at": at]) { $1 }
        case .drawn(let epoch, let windowId, let on):
            return ["k": "drawn", "epoch": epoch, "windowId": windowId, "on": on, "at": at]
        case .parked(let epoch, let windowId, let on):
            return ["k": "parked", "epoch": epoch, "windowId": windowId, "on": on, "at": at]
        case .theme(let epoch, let chunk):
            return chunk.fields.merging(["k": "theme", "epoch": epoch]) { $1 }
        case .data(let kind, let body):
            return body.merging(["k": kind]) { $1 }
        case .bye(let why):
            return ["k": "bye", "why": why]
        }
    }

    // nil if a payload isn't JSON, or the message would be over maxAppMessage.
    func encode() -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              data.count <= LinkProtocol.maxAppMessage else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// ---- The profile handoff's words (HANDOFF.md §1.9, §2.5, §3.3, §6.1; app/PROTOCOL.md "The handoff") ----

// A copy's word that one of its parked windows was used while out of sight: a tab made there that
// Margin didn't open (`tab`), focus landing there that Margin didn't cause (`focus`: the person's
// Window menu, ⌘`, a link from another app), or Margin's own UI asking for a tab that's only there
// (`raise`: the copy doesn't raise it, the app hands off to that window). Sent as a `push` whose
// msg is { type: 'parkedActivity', windowId, tabId?, why }.
struct ParkedActivity: Equatable {
    enum Why: String { case tab, focus, raise }
    static let type = "parkedActivity"
    let windowId: Int
    let tabId: Int?
    let why: Why

    init(windowId: Int, tabId: Int? = nil, why: Why) {
        (self.windowId, self.tabId, self.why) = (windowId, tabId, why)
    }

    // From the push's msg (the push's own windowId stands in when the msg has none, and must agree
    // when both say). A tab's and a raise's need their tab. nil: not one.
    init?(_ msg: JSONObject, windowId pushed: Int? = nil) {
        guard msg["type"] as? String == Self.type, let windowId = int(msg["windowId"]) ?? pushed, windowId >= 0,
              pushed == nil || pushed == windowId,
              let why = (msg["why"] as? String).flatMap(Why.init(rawValue:)) else { return nil }
        let tabId = int(msg["tabId"])
        if why != .focus, tabId == nil { return nil }
        self.init(windowId: windowId, tabId: tabId, why: why)
    }

    var msg: JSONObject {
        var m: JSONObject = ["type": Self.type, "windowId": windowId, "why": why.rawValue]
        if let tabId { m["tabId"] = tabId }
        return m
    }
}

// The handoff's requests to a copy, as a `req`'s type and payload. `notAfter` is milliseconds since
// 1970 (the app and its copies read the same clock): a copy that gets the request after it makes no
// windows call and answers { refused: 'late' }. Once a windows call is made it can't be taken back
// (Safari carries it out when it gets to it), so only the request's arrival is checked.
enum HandoffRequest {
    enum State: String { case fullscreen, normal }

    // B to full screen and focused, or A to normal without taking focus (not focusWindow, which always focuses).
    case setWindowState(windowId: Int, state: State, focused: Bool = false, notAfter: Double)
    // Six frames of the window's tab in front at the full-screen size, after a short nudge (R3, gate G2).
    case frameProbe(windowId: Int, width: Double, height: Double, frames: Int = 6, nudgeMs: Int = 80, timeoutMs: Int = 400)
    // The window's tabs with typed text not sent: asked before any close.
    case windowDrafts(windowId: Int)
    // Today's switch sends these two with no notAfter (none is checked then).
    case focusWindow(windowId: Int, fullscreen: Bool = false, notAfter: Double? = nil)
    case closeWindow(windowId: Int, notAfter: Double? = nil)
    case openSpaceWindow(spaceId: String, fullscreen: Bool = true)

    var type: String {
        switch self {
        case .setWindowState: "setWindowState"
        case .frameProbe: "frameProbe"
        case .windowDrafts: "windowDrafts"
        case .focusWindow: "focusWindow"
        case .closeWindow: "closeWindow"
        case .openSpaceWindow: "openSpaceWindow"
        }
    }

    // The window it's about (the req's windowId, as today's switch sends it), nil for a window to make.
    var windowId: Int? {
        switch self {
        case .setWindowState(let id, _, _, _), .frameProbe(let id, _, _, _, _, _), .windowDrafts(let id),
             .focusWindow(let id, _, _), .closeWindow(let id, _): id
        case .openSpaceWindow: nil
        }
    }

    var payload: JSONObject {
        let ms = { (t: Double) in t.rounded() }
        switch self {
        case .setWindowState(let id, let state, let focused, let notAfter):
            var p: JSONObject = ["windowId": id, "state": state.rawValue, "notAfter": ms(notAfter)]
            if focused { p["focused"] = true }
            return p
        case .frameProbe(let id, let width, let height, let frames, let nudgeMs, let timeoutMs):
            return ["windowId": id, "width": width, "height": height, "frames": frames, "nudgeMs": nudgeMs, "timeoutMs": timeoutMs]
        case .windowDrafts(let id):
            return ["windowId": id]
        case .focusWindow(let id, let fullscreen, let notAfter):
            var p: JSONObject = ["windowId": id]
            if fullscreen { p["fullscreen"] = true }
            if let notAfter { p["notAfter"] = ms(notAfter) }
            return p
        case .closeWindow(let id, let notAfter):
            var p: JSONObject = ["windowId": id]
            if let notAfter { p["notAfter"] = ms(notAfter) }
            return p
        case .openSpaceWindow(let spaceId, let fullscreen):
            return ["spaceId": spaceId, "fullscreen": fullscreen]
        }
    }
}

// What a windows call answered (setWindowState, focusWindow, closeWindow: the reply's `result`).
// `busy` and `refused` mean the copy made no windows call: nothing changed, and a `busy` is evidence
// that an earlier call for that window is stuck (behind a hung tab).
enum WindowCallAnswer: Equatable {
    case landed(windowId: Int, state: String, at: Double) // setWindowState: Safari says the window is in that state (landedAt)
    case timedOut(windowId: Int, state: String) // setWindowState: asked, not in that state within 3 s
    case busy // another windows call for that window was still pending
    case refused(why: String, pastMs: Double?) // `late`: it came past its notAfter (by pastMs)
    case done(state: String?) // focusWindow's { windowId, state }, closeWindow's nothing

    init(_ result: JSONObject) {
        if result["busy"] as? Bool == true { self = .busy; return }
        if let why = result["refused"] as? String { self = .refused(why: why, pastMs: num(result["pastMs"])); return }
        let state = result["state"] as? String
        if let id = int(result["windowId"]), let state {
            if result["timedOut"] as? Bool == true { self = .timedOut(windowId: id, state: state); return }
            if let at = num(result["landedAt"]) { self = .landed(windowId: id, state: state, at: at); return }
        }
        self = .done(state: state)
    }

    // Whether the copy called Safari for it.
    var called: Bool {
        switch self {
        case .busy, .refused: false
        case .landed, .timedOut, .done: true
        }
    }
}

// What a frameProbe answered: the frames the window's tab in front drew, or none (no page there, or
// it didn't answer within the probe's timeoutMs). Times are the page's Date.now(), in milliseconds.
enum FrameProbeAnswer: Equatable {
    struct Frames: Equatable {
        let tabId: Int
        let frames: Int
        let firstAt: Double, lastAt: Double
        let width: Double, height: Double // the page's viewport at the last frame, in CSS pixels
        let hasFocus: Bool // document.hasFocus()
        let visible: Bool // document.visibilityState is 'visible'
        let visibleAt: Double? // the page's last visibilitychange to visible, if it heard one (gate G2 may use it)
    }
    case frames(Frames)
    case none(why: String)

    // nil: not an answer.
    init?(_ result: JSONObject) {
        if let why = result["none"] as? String { self = .none(why: why); return }
        guard let tabId = int(result["tabId"]), let frames = int(result["frames"]), frames >= 0,
              let firstAt = num(result["firstAt"]), let lastAt = num(result["lastAt"]),
              let width = num(result["width"]), let height = num(result["height"]),
              [firstAt, lastAt, width, height].allSatisfy(\.isFinite) else { return nil }
        self = .frames(Frames(tabId: tabId, frames: frames, firstAt: firstAt, lastAt: lastAt, width: width, height: height,
                              hasFocus: result["hasFocus"] as? Bool == true, visible: result["visible"] as? Bool == true,
                              visibleAt: num(result["visibleAt"])))
    }
}

// What windowDrafts answered: the window's tabs with typed text not sent, and those that didn't say in
// time (400 ms). A window is closed only when both are empty.
struct WindowDrafts: Equatable {
    let drafts: [Int]
    let unknown: [Int]
    var mayClose: Bool { drafts.isEmpty && unknown.isEmpty }

    init(drafts: [Int], unknown: [Int]) { (self.drafts, self.unknown) = (drafts, unknown) }

    // nil: not an answer (a close then waits, as for a draft).
    init?(_ result: JSONObject) {
        guard let drafts = result["drafts"] as? [Any], let unknown = result["unknown"] as? [Any] else { return nil }
        self.init(drafts: drafts.compactMap(int), unknown: unknown.compactMap(int))
    }
}

// What openSpaceWindow answered: the new window, and its bounds as Safari gave them (points from the
// top left of the main display, as the windows list has them), so the binder can bind it as made by
// Margin before the copy's next windows list (HANDOFF.md §1.6). An older copy sends no bounds.
struct SpaceWindowAnswer: Equatable {
    let windowId: Int
    let state: String
    let tabId: Int?
    let bounds: CGRect?

    init?(_ result: JSONObject) {
        guard let windowId = int(result["windowId"]) else { return nil }
        self.windowId = windowId
        state = result["state"] as? String ?? "normal"
        tabId = int(result["tabId"])
        if let b = result["bounds"] as? JSONObject, let l = num(b["left"]), let t = num(b["top"]), let w = num(b["width"]), let h = num(b["height"]),
           [l, t, w, h].allSatisfy(\.isFinite), w > 0, h > 0 {
            bounds = CGRect(x: l, y: t, width: w, height: h)
        } else {
            bounds = nil
        }
    }
}

// The overlay page's `framed { mode }` (app/overlay/overlay.js): after the shell's `shown`, on its next
// animation frame, the page says it has drawn, and in which mode (R4: B's overlay framed in full screen).
struct OverlayFramed: Equatable {
    enum Mode: String { case fullscreen, windowed }
    static let op = "framed"
    let mode: Mode

    init(mode: Mode) { self.mode = mode }

    init?(_ body: JSONObject) {
        guard let mode = (body["mode"] as? String).flatMap(Mode.init(rawValue:)) else { return nil }
        self.mode = mode
    }

    var body: JSONObject { ["mode": mode.rawValue] }
}

// Any JSON value as text (a string, a number or null too).
func jsonText(_ value: Any) -> Data? {
    try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
}

func jsonString(_ value: Any) -> String? {
    jsonText(value).flatMap { String(data: $0, encoding: .utf8) }
}
