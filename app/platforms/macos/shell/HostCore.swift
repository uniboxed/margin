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
             offSaid, reentrySaid, fullScreenFailures, retryFullScreen, gone, freshFront, slidEndX, slidEndY, minUnreadSaid
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

    // ---- every app's own window minimum, per version, and each host's own (host/minimums.rs: docs/CORE-REFACTOR.md
    // step 2 part 5). Typed: a pane's minimum is read every frame of a drag. The versions are read here (the core never
    // reads one), the file read and written here (as the routes are). ----

    // A host's minimum as the core holds it: its own as read, else its app's kept one (`known`: none for a window-mode
    // host's). `needsVersion`: its app's kept one with its process's version not read yet (the engine reads it, sets
    // it, asks again; unreadable, that one holds).
    enum Minimum { case none, known(CGSize), needsVersion(CGSize) }
    func minimum(_ h: UInt32, known: Bool) -> Minimum {
        var out = MarginSize()
        lock.lock()
        defer { lock.unlock() }
        switch margin_model_minimum(core, h, known ? 1 : 0, &out) {
        case 1: return .known(CGSize(width: out.width, height: out.height))
        case 2: return .needsVersion(CGSize(width: out.width, height: out.height))
        default: return .none
        }
    }
    func setVersion(_ h: UInt32, _ v: String) {
        var v = v
        lock.lock()
        defer { lock.unlock() }
        v.withUTF8 { margin_model_set_version(core, h, $0.baseAddress, $0.count) }
    }
    // Its tile's minimum as just read (nil: it said none): `.changed` its own from now (rounded up), `.unreadSay` the
    // one read before kept (say it, once), `.same` nothing new.
    enum Learnt { case same, changed, unreadSay }
    func learnMin(_ h: UInt32, _ read: CGSize?) -> Learnt {
        lock.lock()
        defer { lock.unlock() }
        let a: UInt8
        if let read { var s = MarginSize(width: read.width, height: read.height); a = margin_model_learn_min(core, h, &s) } else { a = margin_model_learn_min(core, h, nil) }
        return a == 1 ? .changed : a == 2 ? .unreadSay : .same
    }
    // Its own minimum kept as its app's for its process's `version` (nil: unread, kept as "?"). True: new (saved, said).
    func rememberMin(_ h: UInt32, version: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard var v = version else { return margin_model_remember_min(core, h, nil, 0) }
        return v.withUTF8 { margin_model_remember_min(core, h, $0.baseAddress, $0.count) }
    }
    func held(_ h: UInt32, _ width: CGFloat) {
        lock.lock()
        defer { lock.unlock() }
        margin_model_held(core, h, Double(width))
    }
    // It left its tile with no minimum said: the narrowest it held taken for its minimum width (that width; nil: none).
    func learnFromLeaving(_ h: UInt32) -> CGFloat? {
        lock.lock()
        defer { lock.unlock() }
        let w = margin_model_learn_from_leaving(core, h)
        return w.isNaN ? nil : CGFloat(w)
    }
    // An app's kept minimum: whether one is kept (any version), and the one for the version running (nil: not known).
    func hasMinimum(_ app: String) -> Bool {
        var app = app
        lock.lock()
        defer { lock.unlock() }
        return app.withUTF8 { margin_minimums_has(core, $0.baseAddress, $0.count) }
    }
    func knownMinimum(_ app: String, version: String?) -> CGSize? {
        var app = app, out = MarginSize()
        lock.lock()
        defer { lock.unlock() }
        let found = app.withUTF8 { a in
            guard var v = version else { return margin_minimums_known(core, a.baseAddress, a.count, nil, 0, &out) }
            return v.withUTF8 { margin_minimums_known(core, a.baseAddress, a.count, $0.baseAddress, $0.count, &out) }
        }
        return found ? CGSize(width: out.width, height: out.height) : nil
    }
    // The apps a minimum is kept for (rare: the page told every app's).
    func minimumApps() -> [String] { call(["type": "minimumApps"])["apps"] as? [String] ?? [] }
    // minimums.json beside routes.json: read at launch, written after a change (as the routes are; the core's JSON).
    func loadMinimums(from url: URL) {
        guard let data = try? Data(contentsOf: url), let minimums = try? JSONSerialization.jsonObject(with: data) else { return }
        _ = call(["type": "loadMinimums", "minimums": minimums])
    }
    func saveMinimums(to url: URL) {
        guard let minimums = call(["type": "saveMinimums"])["minimums"], JSONSerialization.isValidJSONObject(minimums),
              let data = try? JSONSerialization.data(withJSONObject: minimums, options: [.sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    // ---- the layout of Margin's page area and its decisions (host/model/visible.rs: docs/CORE-REFACTOR.md step 2 part
    // 1b). Typed: the visible hosts, a host's page area, whether one is visible are read dozens of times an operation
    // and every poll. Ids as their UTF-8 bytes (nothing copied), hosts by handle. ----

    private func withID<R>(_ id: HostID?, _ body: (UnsafePointer<UInt8>?, Int) -> R) -> R {
        guard var raw = id?.raw else { return body(nil, 0) }
        return raw.withUTF8 { body($0.baseAddress, $0.count) }
    }
    private func locked<R>(_ body: () -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // The host the engine holds as `id` (nil: none now). Made for a layout being applied: its role and rect in it.
    func list(_ id: HostID, _ h: UInt32?) { locked { withID(id) { margin_model_list(core, $0, $1, h ?? UInt32(MARGIN_MODEL_NONE)) } } }

    // `id`'s place in the layout (nil: not laid out), set (nil: out of it).
    func layout(_ id: HostID) -> HostVisible? {
        var out = MarginVisible()
        return locked { withID(id) { margin_model_layout_get(core, $0, $1, &out) } } ? HostVisible(out) : nil
    }
    func setLayout(_ id: HostID, _ v: HostVisible?) {
        locked {
            withID(id) { p, n in
                guard var m = v?.margin else { return margin_model_layout_set(core, p, n, nil) }
                margin_model_layout_set(core, p, n, &m)
            }
        }
    }
    var layoutCount: Int { locked { margin_model_layout_count(core) } }
    var generation: UInt64 { locked { margin_model_generation(core) } }
    // A page area's change moved a laid-out host's rect (its host's and its place's).
    func layoutMove(_ id: HostID, _ r: CGRect) { locked { withID(id) { margin_model_layout_move(core, $0, $1, r.marginRect) } } }
    // Every place in the layout (rare: the tests', a log's).
    func layoutEntries() -> [HostID: HostVisible] {
        var out: [HostID: HostVisible] = [:]
        for e in call(["type": "layout"])["entries"] as? [[String: Any]] ?? [] {
            guard let id = e["id"] as? String, let role = (e["role"] as? String).flatMap(HostRole.init(rawValue:)) else { continue }
            out[HostID(raw: id)] = HostVisible(rect: CGRect(coreJSON: e["rect"]), role: role, z: (e["z"] as? NSNumber)?.intValue ?? 0)
        }
        return out
    }

    // The one shown set (nil: none) at `now`: the layout follows outside a layout's change.
    func setShown(_ id: HostID?, now: Double) { locked { withID(id) { margin_model_set_shown(core, $0, $1, now) } } }
    var shownAt: Double { locked { margin_model_shown_at(core) } }
    func setFocus(_ id: HostID?) { locked { withID(id) { margin_model_set_focus(core, $0, $1) } } }
    var placement: HostPlacement {
        get {
            var p = MarginPlacement()
            locked { margin_model_placement(core, &p) }
            return HostPlacement(page: CGRect(p.page), area: CGRect(p.area), display: CGRect(p.display))
        }
        set {
            var p = newValue.margin
            locked { margin_model_set_placement(core, &p) }
        }
    }
    var applying: Bool { locked { margin_model_applying(core) } }
    func isVisible(_ id: HostID) -> Bool { locked { withID(id) { margin_model_is_visible(core, $0, $1) } } }
    // The visible hosts back to front, by handle.
    func visible() -> [UInt32] {
        locked {
            withUnsafeTemporaryAllocation(of: UInt32.self, capacity: 16) { buf in
                let n = margin_model_visible(core, buf.baseAddress, 16)
                if n <= 16 { return Array(buf.prefix(n)) }
                return [UInt32](unsafeUninitializedCapacity: n) { out, count in count = margin_model_visible(core, out.baseAddress, n) }
            }
        }
    }
    private func handle(_ h: UInt32) -> UInt32? { h == UInt32(MARGIN_MODEL_NONE) ? nil : h }
    var mainHost: UInt32? { handle(locked { margin_model_main_host(core) }) }
    func alone(_ id: HostID) -> Bool { locked { withID(id) { margin_model_alone(core, $0, $1) } } }
    func pageOf(_ h: UInt32) -> CGRect {
        var r = MarginRect()
        locked { margin_model_page_of(core, h, &r) }
        return CGRect(r)
    }
    func placementFor(_ h: UInt32) -> HostPlacement {
        var p = MarginPlacement()
        locked { margin_model_placement_for(core, h, &p) }
        return HostPlacement(page: CGRect(p.page), area: CGRect(p.area), display: CGRect(p.display))
    }
    func rank(_ id: HostID) -> Int { Int(locked { withID(id) { margin_model_rank(core, $0, $1) } }) }
    func before(_ id: HostID) -> UInt32? { handle(locked { withID(id) { margin_model_before(core, $0, $1) } }) }
    // A card's rect (nil: its own) below its window's minimum, and whether its process's version is wanted first.
    func belowMinimum(_ h: UInt32, _ rect: CGRect?) -> (below: Bool, needsVersion: Bool) {
        let a: UInt8 = locked {
            guard var r = rect?.marginRect else { return margin_model_below_minimum(core, h, nil) }
            return margin_model_below_minimum(core, h, &r)
        }
        return (a & 1 != 0, a & 2 != 0)
    }
    var shownMinWidth: CGFloat? {
        let w = locked { margin_model_shown_min_width(core) }
        return w.isNaN ? nil : CGFloat(w)
    }
    // An operation's end: nil nothing settled (a layout applied); else the host to show when none is (nil: none).
    func settleBegin() -> UInt32?? {
        let a = locked { margin_model_settle_begin(core) }
        return a == -2 ? nil : .some(a < 0 ? nil : UInt32(a))
    }
    func settleFocus() -> UInt32? { handle(locked { margin_model_settle_focus(core) }) }

    // A decision's word on the one shown: as it is, or set (nil: none).
    enum ShownSet: Equatable { case keep, set(UInt32?) }
    private func shownSet(_ a: Int64) -> ShownSet { a == -2 ? .keep : .set(a < 0 ? nil : UInt32(a)) }
    // The layout held while `id` is placed on its own (`page`: by a page area's change): false, nothing to hold.
    func hold(_ id: HostID, page: Bool) -> Bool { locked { withID(id) { margin_model_hold(core, $0, $1, page ? 1 : 0) } } }
    func release() -> ShownSet { shownSet(locked { margin_model_release(core) }) }

    // A layout's steps (`setLayout`): its extras refused first (each one's index, why, a card's minimum), its start,
    // the held ones laid out again, its end (the one left alone at the page area), the focus.
    enum Refusal: Equatable { case twice, below(CGSize) }
    func layoutRefuse(main: HostID, extras: [(extra: HostExtra, min: CGSize?)]) -> [(Int, Refusal)] {
        let list: [[String: Any]] = extras.map { x in
            var d: [String: Any] = ["id": x.extra.target.id.raw, "role": x.extra.role.rawValue, "rect": x.extra.rect.coreJSON]
            if let m = x.min { d["min"] = ["width": Double(m.width), "height": Double(m.height)] }
            return d
        }
        let a = call(["type": "layoutRefuse", "main": main.raw, "extras": list])
        return (a["refused"] as? [[String: Any]] ?? []).compactMap { r in
            guard let i = (r["index"] as? NSNumber)?.intValue else { return nil }
            if r["why"] as? String == "below", let m = r["min"] as? [String: Any] {
                return (i, .below(CGSize(width: (m["width"] as? NSNumber)?.doubleValue ?? 0, height: (m["height"] as? NSNumber)?.doubleValue ?? 0)))
            }
            return (i, .twice)
        }
    }
    struct LayoutBegun { var before: [UInt32]; var arriving: [HostID]; var held: [HostID]; var deferring: Bool }
    func layoutBegin(main: HostID, mainRect: CGRect?, extras: [HostExtra]) -> LayoutBegun {
        let list: [[String: Any]] = extras.map { ["id": $0.target.id.raw, "role": $0.role.rawValue, "rect": $0.rect.coreJSON] }
        let a = call(["type": "layoutBegin", "main": main.raw, "mainRect": coreOptional(mainRect?.coreJSON), "extras": list])
        return LayoutBegun(before: (a["before"] as? [NSNumber] ?? []).map(\.uint32Value),
                           arriving: (a["arriving"] as? [String] ?? []).map(HostID.init(raw:)),
                           held: (a["held"] as? [String] ?? []).map(HostID.init(raw:)),
                           deferring: a["deferring"] as? Bool ?? false)
    }
    func layoutRelayHeld() -> [UInt32] {
        locked {
            withUnsafeTemporaryAllocation(of: UInt32.self, capacity: 64) { buf in
                let n = margin_model_layout_relay_held(core, buf.baseAddress, 64)
                return Array(buf.prefix(min(n, 64)))
            }
        }
    }
    func layoutEndAlone() -> UInt32? { handle(locked { margin_model_layout_end_alone(core) }) }
    func layoutFocus(focused: HostID?, main: HostID) -> ShownSet {
        shownSet(locked { withID(focused) { f, fn in withID(main) { margin_model_layout_focus(core, f, fn, $0, $1) } } })
    }

    // `bringIn`'s decision at each of its points (host/model/visible.rs `bring_in`).
    enum BringInPoint: UInt8 { case start = 0, take, route, placed }
    enum BringIn: UInt8 { case go = 0, reopen, take, fullScreenAgain, window, placedAgain, sizeFirst, switchIn, placedElsewhere, placeFullScreen }
    func bringIn(_ h: UInt32, _ point: BringInPoint, isNew: Bool = false, isApp: Bool = false, taken: Bool = false, retrying: Bool = false, preparing: Bool = false) -> BringIn {
        let facts: UInt32 = (isNew ? 1 : 0) | (isApp ? 2 : 0) | (taken ? 4 : 0) | (retrying ? 8 : 0) | (preparing ? 16 : 0)
        return BringIn(rawValue: locked { margin_model_bring_in(core, h, point.rawValue, facts) }) ?? .go
    }

    // ---- where each visible host's window goes, and cut panes (host/model/panes.rs: docs/CORE-REFACTOR.md step 2 part
    // 3). Typed: `frame` is asked per follower per frame of a drag. Each answer says too whether a host's minimum was
    // read as its app's kept one with its process's version unread (`wanted`): the engine reads those versions
    // (`versionsWanted`) and asks again. ----

    private var wanted: Bool { margin_model_versions_wanted(core, nil, 0) > 0 }
    // The hosts the last call noted (rare: only when it said `wanted`).
    func versionsWanted() -> [UInt32] {
        locked {
            withUnsafeTemporaryAllocation(of: UInt32.self, capacity: 8) { buf in
                Array(buf.prefix(min(margin_model_versions_wanted(core, buf.baseAddress, 8), 8)))
            }
        }
    }
    // The page area of a drag being followed (nil: none under way).
    func setLivePage(_ page: CGRect?) {
        locked {
            guard var r = page?.marginRect else { return margin_model_set_live_page(core, nil) }
            margin_model_set_live_page(core, &r)
        }
    }
    private func withPlacement<R>(_ p: HostPlacement?, _ body: (UnsafePointer<MarginPlacement>?) -> R) -> R {
        guard var m = p?.margin else { return body(nil) }
        return body(&m)
    }
    private func withRect<R>(_ r: CGRect?, _ body: (UnsafePointer<MarginRect>?) -> R) -> R {
        guard var m = r?.marginRect else { return body(nil) }
        return body(&m)
    }
    private func placement(_ m: MarginPlacement) -> HostPlacement { HostPlacement(page: CGRect(m.page), area: CGRect(m.area), display: CGRect(m.display)) }

    // Where a host's window goes for a page area (`p`, nil: its own).
    func frame(_ h: UInt32, _ p: HostPlacement?) -> (CGRect, wanted: Bool) {
        var out = MarginRect()
        return locked { withPlacement(p) { margin_model_frame(core, h, $0, &out) }; return (CGRect(out), wanted) }
    }
    // Its placement as its own full-screen Space reserves it (its window entering, a member placed).
    func entryFitted(_ h: UInt32) -> (HostPlacement, wanted: Bool) {
        var out = MarginPlacement()
        return locked { margin_model_fitted(core, h, nil, true, &out); return (placement(out), wanted) }
    }
    // Its tile's rect for a page area from Margin's own tile (nil: none).
    func tileRect(_ h: UInt32, _ p: HostPlacement?, home: CGRect) -> (CGRect?, wanted: Bool) {
        var out = MarginRect()
        return locked {
            let ok = withPlacement(p) { margin_model_tile_rect(core, h, $0, home.marginRect, &out) }
            return (ok ? CGRect(out) : nil, wanted)
        }
    }
    func isCut(_ h: UInt32) -> (Bool, wanted: Bool) { locked { (margin_model_is_cut(core, h), wanted) } }
    // A cut pane's sides its arrows slide to (nil: not cut).
    func cut(_ h: UInt32) -> (PaneCut?, wanted: Bool) {
        locked {
            let bits = margin_model_cut(core, h)
            guard bits >= 0 else { return (nil, wanted) }
            return (PaneCut(sides: Set(PaneSide.allCases.filter { bits & $0.bit != 0 })), wanted)
        }
    }
    func slideFor(_ h: UInt32, _ side: PaneSide) -> (PaneSlide?, wanted: Bool) {
        var out = MarginSlide()
        return locked {
            guard margin_model_slide_for(core, h, side.index, &out) else { return (nil, wanted) }
            func end(_ v: Int8) -> Bool? { v < 0 ? nil : v == 1 }
            return (PaneSlide(pane: CGRect(out.pane), endX: end(out.end_x), endY: end(out.end_y)), wanted)
        }
    }
    // The visible panes a cut pane's window (at `at`, nil: its frame) lies under, back to front.
    func lyingUnder(_ h: UInt32, at: CGRect? = nil) -> ([UInt32], wanted: Bool) {
        locked {
            withUnsafeTemporaryAllocation(of: UInt32.self, capacity: 16) { buf in
                let n = withRect(at) { margin_model_lying_under(core, h, $0, buf.baseAddress, 16) }
                return (Array(buf.prefix(min(n, 16))), wanted)
            }
        }
    }
    func tucked(_ h: UInt32, at: CGRect? = nil) -> (Bool, wanted: Bool) { locked { (withRect(at) { margin_model_tucked(core, h, $0) }, wanted) } }
    // Whether a visible cut pane's window is over a pane it lies under in the on-screen list (front to back).
    func overUnder(_ h: UInt32, _ frontToBack: [Int]) -> (Bool, wanted: Bool) {
        locked {
            let list = frontToBack.map { Int64($0) }
            return (list.withUnsafeBufferPointer { margin_model_over_under(core, h, $0.baseAddress, $0.count) }, wanted)
        }
    }
    // One frame of a slide `elapsed` seconds in: its page rect, its tile's rect from Margin's own tile `home` in Margin's
    // placement (nil: none), whether it's the last.
    func slideStep(from: CGRect, to: CGRect, elapsed: Double, time: Double, home: CGRect?) -> (page: CGRect, tile: CGRect?, last: Bool) {
        var page = MarginRect(), tile = MarginRect()
        let a = locked { withRect(home) { margin_model_slide_step(core, from.marginRect, to.marginRect, elapsed, time, $0, &page, &tile) } }
        return (CGRect(page), a & 2 != 0 ? CGRect(tile) : nil, a & 1 != 0)
    }

    // ---- the visible windows' order (host/model/order.rs: docs/CORE-REFACTOR.md step 2 part 2): the order wanted (to
    // read each window's bounds), then the plan (JSON, once a fronting: what to raise in what order, each over the cut
    // pane it lies over or not, the keys, the confirm), the window server's order and the focused one's check typed
    // (read every few milliseconds while it's waited for). ----

    func frontWanted() -> ([UInt32], wanted: Bool) {
        locked {
            withUnsafeTemporaryAllocation(of: UInt32.self, capacity: 16) { buf in
                let n = margin_model_front_wanted(core, buf.baseAddress, 16)
                if n <= 16 { return (Array(buf.prefix(n)), wanted) }
                return ([UInt32](unsafeUninitializedCapacity: n) { out, count in count = margin_model_front_wanted(core, out.baseAddress, n) }, wanted)
            }
        }
    }
    enum FrontConfirm: String { case none, wait, fresh }
    struct FrontPlan {
        var wanted: [UInt32] = [] // back to front
        var focused: UInt32?
        var cutFocused = false
        var raises: [(host: UInt32, over: UInt32?)] = []
        var keys = false // the focused one's keys after the raises, and done
        var confirm = FrontConfirm.none
        var belowTop: [UInt32] = [] // the hosts that overlap the focused one, by place in `wanted`
    }
    // `bounds`: each wanted host's window bounds (nil: unread); `order`: their windows' order in the window server's,
    // back to front (nil: unread); `fresh`: hosts whose window came in with its tile a moment ago.
    func frontPlan(bounds: [CGRect?], order: [Int]?, fresh: [UInt32]) -> (FrontPlan, wanted: Bool) {
        let a = call(["type": "frontPlan", "bounds": bounds.map { coreOptional($0?.coreJSON) }, "order": coreOptional(order), "fresh": fresh.map { Int($0) }])
        var p = FrontPlan()
        p.wanted = (a["wanted"] as? [NSNumber] ?? []).map(\.uint32Value)
        p.focused = (a["focused"] as? NSNumber)?.uint32Value
        p.cutFocused = a["cutFocused"] as? Bool ?? false
        p.raises = (a["raises"] as? [[String: Any]] ?? []).compactMap { r in
            (r["host"] as? NSNumber).map { (host: $0.uint32Value, over: (r["over"] as? NSNumber)?.uint32Value) }
        }
        p.keys = a["keys"] as? Bool ?? false
        p.confirm = (a["confirm"] as? String).flatMap(FrontConfirm.init(rawValue:)) ?? .none
        p.belowTop = (a["belowTop"] as? [NSNumber] ?? []).map(\.uint32Value)
        return (p, locked { wanted })
    }
    // `windows` (back to front as wanted) in the window server's order back to front, from its on-screen list (front to
    // back; nil: unread). Nil: unread, or one of them not in it.
    func serverOrder(windows: [Int], screen: [Int]?) -> [Int]? {
        guard let screen else { return nil }
        // (An empty list read: none of them in it. Its pointer may be null, which the core takes for unread.)
        guard !screen.isEmpty else { return windows.isEmpty ? [] : nil }
        let w = windows.map { Int64($0) }, s = screen.map { Int64($0) }
        var out = [Int64](repeating: 0, count: w.count)
        let n = w.withUnsafeBufferPointer { wb in
            s.withUnsafeBufferPointer { sb in out.withUnsafeMutableBufferPointer { margin_order_server(wb.baseAddress, wb.count, sb.baseAddress, sb.count, $0.baseAddress, $0.count) } }
        }
        return n < 0 ? nil : out.prefix(Int(n)).map { Int($0) }
    }
    // Whether the focused one (the last of `windows`) is behind a host it overlaps (`below`) in the on-screen list now.
    func topBehind(windows: [Int], below: [UInt32], screen: [Int]?) -> Bool {
        let w = windows.map { Int64($0) }
        guard let screen else { return w.withUnsafeBufferPointer { wb in below.withUnsafeBufferPointer { margin_order_top_behind(wb.baseAddress, wb.count, $0.baseAddress, $0.count, nil, 0) } } }
        let s = screen.map { Int64($0) }
        return w.withUnsafeBufferPointer { wb in below.withUnsafeBufferPointer { bb in s.withUnsafeBufferPointer { margin_order_top_behind(wb.baseAddress, wb.count, bb.baseAddress, bb.count, $0.baseAddress, $0.count) } } }
    }

    // What the model's decisions read of the engine's options (one call per change of them).
    func configure(tolerance: CGFloat, toolbarRoom: CGFloat, returnsMax: Int, returnsWithin: Double) {
        _ = call(["type": "configure", "tolerance": Double(tolerance), "toolbarRoom": Double(toolbarRoom), "returnsMax": max(0, returnsMax), "returnsWithin": returnsWithin])
    }

    // ---- the budgets of Margin's own corrections that outlive a show, and the full-screen ladder (host/model/budget.rs:
    // docs/CORE-REFACTOR.md step 2 part 4). Typed: the cut order's is asked by the poll. ----

    enum Budget: UInt8 { case strayReturns = 0, reentry, offInPlace, offElsewhere, cutRepair }
    // Asked before its action: go (its entries now, this one in), spent and to be said (by its count, or a cut pane's by
    // its streak of repairs that didn't take), spent and said already, or held (`guarded`: the loop guard on; too many
    // reactions this second across every host, until `until`: nothing spent, nothing made).
    enum Spend: Equatable { case go(count: Int), say(count: Int, streak: Bool), said(count: Int), held(until: Double) }
    func spend(_ h: UInt32, _ kind: Budget, now: Double, guarded: Bool) -> Spend {
        var n: UInt32 = 0
        var until = 0.0
        lock.lock()
        defer { lock.unlock() }
        switch margin_budget_spend(core, h, kind.rawValue, now, guarded, &n, &until) {
        case 0: return .go(count: Int(n))
        case 4: return .held(until: until)
        case 1: return .say(count: Int(n), streak: false)
        case 3: return .say(count: Int(n), streak: true)
        default: return .said(count: Int(n))
        }
    }
    // A cut pane's repair done: the ones in a row that didn't take now (0: it took).
    func repairTook(_ h: UInt32, _ took: Bool) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return Int(margin_budget_repair_took(core, h, took))
    }
    func cutOrderRight(_ h: UInt32) {
        lock.lock()
        defer { lock.unlock() }
        margin_budget_cut_order_right(core, h)
    }
    // The ladder: a full-screen show backed out (true: tried again at its next show), another window adopted in its
    // place (asked before its fields change), the loop guard's move to window mode.
    func fullScreenFailed(_ h: UInt32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return margin_model_full_screen_failed(core, h)
    }
    func adopted(_ h: UInt32, canFullScreen: Bool) {
        lock.lock()
        defer { lock.unlock() }
        margin_model_adopted(core, h, canFullScreen)
    }
    func movedToWindow(_ h: UInt32) {
        lock.lock()
        defer { lock.unlock() }
        margin_model_moved_to_window(core, h)
    }
}

// As the core numbers a cut pane's sides (host/model/panes.rs `Side`).
nonisolated extension PaneSide {
    var index: UInt8 {
        switch self {
        case .left: return 0
        case .right: return 1
        case .up: return 2
        case .down: return 3
        }
    }
    var bit: Int8 { Int8(1 << index) }
}

nonisolated extension HostVisible {
    init(_ v: MarginVisible) { self.init(rect: v.has_rect ? CGRect(v.rect) : nil, role: HostRole(model: Int64(v.role)), z: Int(v.z)) }
    var margin: MarginVisible { MarginVisible(rect: rect?.marginRect ?? MarginRect(), has_rect: rect != nil, role: UInt8(role.model), z: Int64(z)) }
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
