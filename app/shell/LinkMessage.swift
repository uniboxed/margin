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
    case theme(epoch: String, chunk: Chunk)
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
                                instanceId: m["instanceId"] as? String, origin: m["origin"] as? String, since: num(m["since"]), pid: int(m["pid"])))
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
            return .push(epoch: epoch, windowId: int(m["windowId"]), msg: msg)
        case "theme":
            guard let epoch, let chunk = Chunk(m) else { return nil }
            return .theme(epoch: epoch, chunk: chunk)
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

// Any JSON value as text (a string, a number or null too).
func jsonText(_ value: Any) -> Data? {
    try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
}

func jsonString(_ value: Any) -> String? {
    jsonText(value).flatMap { String(data: $0, encoding: .utf8) }
}
