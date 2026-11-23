// The hosting core (margin-core's `host` module, Rust: app/shared/core/src/host; docs/ARCHITECTURE-PLAN.md) as
// Margin.app calls it, through margin-ffi's C interface (app/platforms/macos/ffi, `import MarginCore`). Everything that decides
// is there, the same on every OS: the window kinds, the window choice, the reconciler, the layout, the loop guard,
// the causes, the routes. This file only turns Swift's values into the core's JSON and back; the layout's hot path
// (every frame of a drag) uses the typed calls, no JSON.
//
// `shared` for the stateless requests (the kinds, the reconciler's step, the window choice: pure functions); each
// HostEngine its own core for the stateful ones (its loop guard, its causes, its routes), so two engines (a test's,
// another Margin window's) never share a count. One call at a time per core (a lock, free uncontended). The core never panics on what it's given: a bad request is an answer
// (`{"error": …}`), said once in the log.

import AppKit
import MarginCore

nonisolated final class HostCore: @unchecked Sendable {
    static let shared = HostCore()

    private let core: OpaquePointer
    private let lock = NSLock()
    private var errorsSaid: Set<String> = []

    // The budgets and constants, read once (the core's, never a copy kept here).
    let constants: [String: Any]

    init() {
        let core = margin_host_new()!
        self.core = core
        constants = HostCore.once(core, ["type": "constants"])
    }

    private static func once(_ core: OpaquePointer, _ request: [String: Any]) -> [String: Any] {
        guard let data = try? JSONSerialization.data(withJSONObject: request) else { return [:] }
        var len = 0
        let out = data.withUnsafeBytes { raw in margin_host_call(core, raw.bindMemory(to: UInt8.self).baseAddress, data.count, &len) }
        guard let out else { return [:] }
        defer { margin_buffer_free(out, len) }
        return (try? JSONSerialization.jsonObject(with: Data(bytesNoCopy: out, count: len, deallocator: .none))) as? [String: Any] ?? [:]
    }

    // One request → its answer (empty with an "error" key when the core refused it).
    func call(_ request: [String: Any]) -> [String: Any] {
        guard JSONSerialization.isValidJSONObject(request), let data = try? JSONSerialization.data(withJSONObject: request) else {
            return said(["error": "the request isn't JSON"], request)
        }
        lock.lock()
        defer { lock.unlock() }
        var len = 0
        let out = data.withUnsafeBytes { raw in
            margin_host_call(core, raw.bindMemory(to: UInt8.self).baseAddress, data.count, &len)
        }
        guard let out else { return said(["error": "no answer"], request) }
        defer { margin_buffer_free(out, len) }
        let answer = (try? JSONSerialization.jsonObject(with: Data(bytesNoCopy: out, count: len, deallocator: .none))) as? [String: Any]
        guard let answer else { return said(["error": "the answer isn't JSON"], request) }
        return answer["error"] != nil ? said(answer, request) : answer
    }

    private func said(_ answer: [String: Any], _ request: [String: Any]) -> [String: Any] {
        let type = request["type"] as? String ?? "?"
        if errorsSaid.insert(type).inserted {
            let line = "host core: a \(type) request refused: \(answer["error"] as? String ?? "?") (said once a kind)"
            DispatchQueue.main.async { Diagnostics.warn(line) }
        }
        return answer
    }

    func constant(_ key: String) -> Double? { (constants[key] as? NSNumber)?.doubleValue }
    func budget(_ family: String) -> Int? { ((constants["budgets"] as? [String: Any])?[family] as? NSNumber)?.intValue }

    // ---- the hosts' model (host/model.rs): each host's fields by its handle, typed (read dozens of times an operation
    // and every frame of a drag: no JSON, nothing allocated in the core), under the same lock as `call` ----

    // A field's number (host/model.rs `Field`): whole numbers and flags, times (nil: none), rects, lists of times.
    enum Field: UInt32 {
        case window = 0, pid, role, phase, mode, resizable, member, tiled, noTiles, unread, strays, offScreenReads, offPageReads,
             offSaid, reentrySaid, fullScreenFailures, retryFullScreen, gone, freshFront, slidEndX, slidEndY
        case visibleAt = 32, goneAt, offActedFor, offInPlaceSaid, narrowestHeld
        case rect = 64, placedPage, minSize, slidPane
        case returns = 96, offTries, reentries
    }

    // A new host's handle (its first open), and its going (its `Host` gone).
    func modelAdd(id: String, app: String, window: Int, pid: pid_t) -> UInt32 {
        var id = id, app = app
        lock.lock()
        defer { lock.unlock() }
        return id.withUTF8 { i in app.withUTF8 { a in margin_model_add(core, i.baseAddress, i.count, a.baseAddress, a.count, Int64(window), Int64(pid)) } }
    }
    func modelRemove(_ h: UInt32) {
        lock.lock()
        defer { lock.unlock() }
        margin_model_remove(core, h)
    }

    func int(_ h: UInt32, _ f: Field) -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return margin_model_get(core, h, f.rawValue)
    }
    func setInt(_ h: UInt32, _ f: Field, _ v: Int64) {
        lock.lock()
        defer { lock.unlock() }
        margin_model_set(core, h, f.rawValue, v)
    }
    func flag(_ h: UInt32, _ f: Field) -> Bool { int(h, f) != 0 }
    func setFlag(_ h: UInt32, _ f: Field, _ v: Bool) { setInt(h, f, v ? 1 : 0) }

    func real(_ h: UInt32, _ f: Field) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        let v = margin_model_get_real(core, h, f.rawValue)
        return v.isNaN ? nil : v
    }
    func setReal(_ h: UInt32, _ f: Field, _ v: Double?) {
        lock.lock()
        defer { lock.unlock() }
        margin_model_set_real(core, h, f.rawValue, v ?? .nan)
    }

    func rect(_ h: UInt32, _ f: Field) -> CGRect? {
        var out = MarginRect()
        lock.lock()
        defer { lock.unlock() }
        return margin_model_get_rect(core, h, f.rawValue, &out) ? CGRect(out) : nil
    }
    func setRect(_ h: UInt32, _ f: Field, _ v: CGRect?) {
        lock.lock()
        defer { lock.unlock() }
        guard var r = v?.marginRect else { margin_model_set_rect(core, h, f.rawValue, nil); return }
        margin_model_set_rect(core, h, f.rawValue, &r)
    }

    func times(_ h: UInt32, _ f: Field) -> [Double] {
        lock.lock()
        defer { lock.unlock() }
        let n = margin_model_times(core, h, f.rawValue, nil, 0)
        guard n > 0 else { return [] }
        return [Double](unsafeUninitializedCapacity: n) { buffer, count in
            count = min(n, margin_model_times(core, h, f.rawValue, buffer.baseAddress, n))
        }
    }
    func setTimes(_ h: UInt32, _ f: Field, _ v: [Double]) {
        lock.lock()
        defer { lock.unlock() }
        v.withUnsafeBufferPointer { margin_model_set_times(core, h, f.rawValue, $0.baseAddress, $0.count) }
    }
}

// ---- JSON shapes (host/api.rs) ----

nonisolated extension CGRect {
    var coreJSON: [String: Any] { ["x": Double(minX), "y": Double(minY), "width": Double(width), "height": Double(height)] }
    init?(coreJSON v: Any?) {
        guard let d = v as? [String: Any], let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue,
              let w = (d["width"] as? NSNumber)?.doubleValue, let h = (d["height"] as? NSNumber)?.doubleValue else { return nil }
        self.init(x: x, y: y, width: w, height: h)
    }
    var marginRect: MarginRect { MarginRect(x: Double(minX), y: Double(minY), width: Double(width), height: Double(height)) }
    init(_ r: MarginRect) { self.init(x: r.x, y: r.y, width: r.width, height: r.height) }
}

nonisolated extension HostPlacement {
    var coreJSON: [String: Any] { ["page": page.coreJSON, "area": area.coreJSON, "display": display.coreJSON] }
    var margin: MarginPlacement { MarginPlacement(page: page.marginRect, area: area.marginRect, display: display.marginRect) }
}

nonisolated extension WindowPlace {
    var coreName: String {
        switch self {
        case .margin: return "margin"
        case .desktop: return "desktop"
        case .fullScreen: return "fullScreen"
        case .several: return "several"
        case .parked: return "parked"
        case .nowhere: return "nowhere"
        case .unread: return "unread"
        }
    }
}

nonisolated extension ServerWindow {
    var coreJSON: [String: Any] {
        ["number": number, "pid": Int(pid), "layer": layer, "bounds": bounds.coreJSON, "onScreen": onScreen, "alpha": alpha, "order": order]
    }
}

nonisolated func coreOptional(_ v: Any?) -> Any { v ?? NSNull() }

// As the core's model numbers them (host/model.rs `Role`, `Mode`).
nonisolated extension HostRole {
    init(model v: Int64) { self = v == 1 ? .pane : v == 2 ? .card : .main }
    var model: Int64 {
        switch self {
        case .main: return 0
        case .pane: return 1
        case .card: return 2
        }
    }
}

nonisolated extension HostMode {
    init(model v: Int64) { self = v == 1 ? .window : .fullScreen }
    var model: Int64 { self == .window ? 1 : 0 }
}

// ---- the loop guard, the causes, the routes (host/guard.rs, causes.rs, routes.rs) ----

nonisolated enum HostGuardVerdict: Equatable {
    case go
    case stop(host: String, key: String, count: Int)
    case hold(until: Double)
}

nonisolated enum HostRoute: String, Equatable, Sendable {
    case tiles, members, window
    var text: String { self == .window ? "window mode" : rawValue }
}

nonisolated struct HostCause: Equatable {
    var host: String
    var kind: WindowKind?
    var person: Bool
    var text: String
}

nonisolated extension HostCore {
    // A reaction about to be applied for `host` (HostID's log name, or "margin").
    func react(now: Double, host: String, key: String) -> HostGuardVerdict {
        let a = call(["type": "react", "now": now, "host": host, "key": key])
        switch a["verdict"] as? String {
        case "stop": return .stop(host: a["host"] as? String ?? host, key: a["key"] as? String ?? key, count: (a["count"] as? NSNumber)?.intValue ?? 0)
        case "hold": return .hold(until: (a["until"] as? NSNumber)?.doubleValue ?? now + 1)
        default: return .go // (a refused request never stops anything)
        }
    }
    // The person acted (on a host, or on everything): nothing they caused counts as a loop.
    func person(now: Double, host: String? = nil) {
        var r: [String: Any] = ["type": "person", "now": now]
        if let host { r["host"] = host }
        _ = call(r)
    }
    func cleared(host: String) { _ = call(["type": "cleared", "host": host]) }

    enum Seen { case opened, closed }
    func note(now: Double, _ seen: Seen, host: String, window: Int, kind: WindowKind) {
        _ = call(["type": "note", "now": now, "event": ["type": seen == .opened ? "opened" : "closed", "host": host, "window": window, "kind": kind.rawValue]])
    }
    func noteSized(now: Double, host: String) {
        _ = call(["type": "note", "now": now, "event": ["type": "sized", "host": host]])
    }
    // Why the tiles of Margin's Space were laid out again.
    func explainRelayout(now: Double) -> HostCause {
        let a = call(["type": "explain", "now": now, "change": "tilesRelaidOut"])
        return HostCause(host: a["host"] as? String ?? "margin", kind: (a["kind"] as? String).flatMap(WindowKind.init(rawValue:)),
                         person: a["person"] as? Bool ?? false, text: a["text"] as? String ?? "")
    }

    func route(bundle: String, version: String, available: [HostRoute]) -> (route: HostRoute?, why: String?) {
        let a = call(["type": "route", "bundle": bundle, "version": version, "available": available.map(\.rawValue)])
        return ((a["route"] as? String).flatMap(HostRoute.init(rawValue:)), (a["held"] as? [String: Any])?["why"] as? String)
    }
    func stepDown(now: Double, bundle: String, version: String, from: HostRoute, available: [HostRoute], why: String) -> HostRoute? {
        let a = call(["type": "stepDown", "now": now, "bundle": bundle, "version": version, "from": from.rawValue, "available": available.map(\.rawValue), "why": why])
        return (a["route"] as? String).flatMap(HostRoute.init(rawValue:))
    }
    // The routes held, as saved (Application Support/Margin/routes.json), read at launch and written after a change.
    func loadRoutes(from url: URL) {
        guard let data = try? Data(contentsOf: url), let routes = try? JSONSerialization.jsonObject(with: data) else { return }
        _ = call(["type": "loadRoutes", "routes": routes])
    }
    func saveRoutes(to url: URL) {
        guard let routes = call(["type": "saveRoutes"])["routes"], JSONSerialization.isValidJSONObject(routes),
              let data = try? JSONSerialization.data(withJSONObject: routes, options: [.sortedKeys]) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

// ---- the loop in parts (host/driver.rs): the next correction, then the guard and its try ----

nonisolated enum HostAdmit: Equatable {
    case go(tried: Int)
    case held(until: Double)
    case stopped(why: String, from: HostRoute, to: HostRoute?)
}

nonisolated extension HostCore {
    // The host's next correction of those the loop makes (`putBack`: one out of its place too), its tries the core's.
    func decide(now: Double, host: String, _ s: HostSituation, _ d: HostDesired, putBack: Bool = false) -> HostCorrection? {
        let a = call(["type": "decide", "now": now, "host": host, "situation": s.coreJSON, "desired": d.coreName, "putBack": putBack])
        return (a["correction"] as? [String: Any]).flatMap(HostCorrection.init(coreJSON:))
    }
    // `c` about to be applied: through the guard when `guarded` (a reaction), its try counted on a go; a stop moved the
    // host down a route in the core's record (said back: the caller moves it). A refused request: go, uncounted.
    func admit(now: Double, host: String, _ c: HostCorrection, guarded: Bool, bundle: String, version: String, from: HostRoute, available: [HostRoute]) -> HostAdmit {
        let a = call(["type": "admit", "now": now, "host": host, "correction": c.coreJSON, "guarded": guarded,
                      "identity": ["bundle": bundle, "version": version, "from": from.rawValue, "available": available.map(\.rawValue)]])
        switch a["type"] as? String {
        case "held": return .held(until: (a["until"] as? NSNumber)?.doubleValue ?? now + 1)
        case "stopped":
            return .stopped(why: a["why"] as? String ?? "", from: (a["from"] as? String).flatMap(HostRoute.init(rawValue:)) ?? from,
                            to: (a["to"] as? String).flatMap(HostRoute.init(rawValue:)))
        default: return .go(tried: (a["tried"] as? NSNumber)?.intValue ?? 0)
        }
    }
    // A try counted outside the loop (a show's own ladder); the tries of a key now.
    @discardableResult func record(now: Double, host: String, key: String) -> Int {
        (call(["type": "record", "now": now, "host": host, "key": key])["tried"] as? NSNumber)?.intValue ?? 0
    }
    func tried(now: Double, host: String, key: String) -> Int {
        (call(["type": "tried", "now": now, "host": host, "key": key])["tried"] as? NSNumber)?.intValue ?? 0
    }
    // A show: the host's budgets anew. Gone: nothing kept of it.
    func resetTries(host: String) { _ = call(["type": "resetTries", "host": host]) }
    func forget(host: String) { _ = call(["type": "forget", "host": host]) }
}

// ---- the window let in front of Margin's window (host/front.rs) ----

nonisolated extension HostCore {
    // The shown app's window let in front of Margin's window now (nil: none), from a look at rest: the window server's
    // list front to back (`ServerWindow.coreJSON`, with `keptBehind` and `marginOnly`).
    // `visiblePids`, `rects`: several visible (docs/PEEK-SPLIT.md §1): every visible host's app, each one's own rect.
    func front(now: Double, windows: [[String: Any]], ownPid: pid_t, marginWindow: Int, hosted: [Int], shownPid: pid_t?, visiblePids: [pid_t] = [], rects: [CGRect] = [],
               placement: HostPlacement, fresh: Bool) -> Int? {
        var look: [String: Any] = ["now": now, "windows": windows, "ownPid": Int(ownPid), "marginWindow": marginWindow, "hosted": hosted,
                                   "placement": placement.coreJSON, "fresh": fresh]
        if !visiblePids.isEmpty { look["visiblePids"] = visiblePids.map { Int($0) } }
        if !rects.isEmpty { look["rects"] = rects.map(\.coreJSON) }
        if let shownPid { look["shownPid"] = Int(shownPid) }
        return (call(["type": "front", "look": look])["front"] as? NSNumber)?.intValue
    }
    func frontReset() { _ = call(["type": "frontReset"]) }
    func frontUnsteady() { _ = call(["type": "frontUnsteady"]) }
}

// ---- when the engine looks again (host/schedule.rs) ----

nonisolated extension HostCore {
    // Seconds until the next look (nil: none until an event). Typed (every poll asks): no JSON, nothing kept.
    func nextPoll(hosting: Bool, links: Bool, pending: Bool, activeFor: Double?) -> Double? {
        let after = margin_schedule_next_poll(hosting, links, pending, activeFor ?? .nan)
        return after < 0 ? nil : after
    }
}

// ---- an app's launch, its pid used again (host/exits.rs) ----

nonisolated enum HostExits {
    // Whether a running app (launched `now`) is the launch known (`then`): within 2 s; either one unknown: the same.
    static func sameLaunch(_ then: Double?, _ now: Double?) -> Bool { margin_exits_same_launch(then ?? .nan, now ?? .nan) }
}
