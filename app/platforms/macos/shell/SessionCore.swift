// margin-core's session object (margin-ffi's `margin_session_*`, docs/CORE-REFACTOR.md step 3) as HostedSession calls
// it: JSON in for the rare inputs and answers, and out only when an answer has more than its readiness and deadline
// (commands to start, a reply); the ports a show asks typed (`call`: their number, their texts as bytes), the rare
// ones JSON (`port`); the facade's fields read and edited as typed rows; typed reads for the revisions, idle and the
// log. Its ports call the session (`owner`) synchronously during a call, on the main thread, and may call back in.

import Foundation
import MarginCore

// One row of one of the core's fields (session/state.rs `Row`: the parts its field uses).
struct CoreRow {
    var i0 = 0
    var f = 0.0
    var b0 = false
    var b1 = false
    var s0: String?
    var s1: String?
    var s2: String?
}

final class SessionCore {
    private var core: OpaquePointer?
    private let library: Library // (its object the session reads in place: kept as long as the session)
    private let box = Box()
    private final class Box { weak var owner: HostedSession? }
    var owner: HostedSession? {
        get { box.owner }
        set { box.owner = newValue }
    }

    // The fields with a revision (session/state.rs `Field`), by their names in a `state` input.
    enum Field: UInt32 {
        case shown = 0, open, safariWindows, done, requested, hostingWindow, labels, showing, marginPages, marginOpen, cycledAt
        case safariTabs, safariMuted, safariAudio, preparingWindow, preparingProfile, requesting, made
    }

    // The typed ports by their numbers (margin-ffi session.rs `PortKind`).
    enum PortKind: UInt32 {
        case window = 0, windowIds, engineShown, isHosted, safariProfiles, linkEpoch, appName, appRuns, showsAlone, stopHidingWoken
        case windowIdsOf, setShowing, setMarginPage, push, changed, wokenByMenu, unopenable, log
        case cardLeaving = 20, cardReturning, pinnedOrFavorite, settleHosting, refreshLoading, leaveMarginPage, hasLayout, clearLayout
        case clearElsewhere, forgetElsewhere
    }
    // A typed port's "none".
    static let none = Int64.min

    init(library: Library, options: JSONObject) {
        self.library = library
        let ctx = Unmanaged.passUnretained(box).toOpaque()
        core = KeysCore.bytes(KeysCore.json(options)) { p, n in
            margin_session_new(library.corePointer, p, n, ctx, { ctx in
                guard let ctx else { return 0 }
                return MainActor.assumeIsolated { Unmanaged<Box>.fromOpaque(ctx).takeUnretainedValue().owner?.now() ?? 0 }
            }, { ctx, ask, len, outLen in
                guard let ctx, let ask, let outLen else { return nil }
                let question = (try? JSONSerialization.jsonObject(with: Data(bytes: ask, count: len))) as? JSONObject ?? [:]
                let reply = MainActor.assumeIsolated { Unmanaged<Box>.fromOpaque(ctx).takeUnretainedValue().owner?.port(question) ?? [:] }
                guard let data = try? JSONSerialization.data(withJSONObject: reply), let out = malloc(max(data.count, 1)) else { return nil }
                data.copyBytes(to: out.assumingMemoryBound(to: UInt8.self), count: data.count)
                outLen.pointee = data.count
                return out.assumingMemoryBound(to: UInt8.self)
            }, { ctx, kind, args, out in
                guard let ctx, let args else { return SessionCore.none }
                return MainActor.assumeIsolated {
                    Unmanaged<Box>.fromOpaque(ctx).takeUnretainedValue().owner?.typedPort(kind, args.pointee, out) ?? SessionCore.none
                }
            })
        }
    }

    deinit { margin_session_free(core) }

    // A text the core gave (none: a null pointer).
    nonisolated static func text(_ b: MarginBytes) -> String? {
        guard let p = b.ptr else { return nil }
        return String(decoding: UnsafeBufferPointer(start: p, count: b.len), as: UTF8.self)
    }
    // A text a typed port answers, given back during its call.
    nonisolated static func give(_ text: String, _ out: OpaquePointer?) {
        var t = text
        t.withUTF8 { margin_port_out_text(out, $0.baseAddress ?? UnsafePointer(bitPattern: 1), $0.count) }
    }
    nonisolated static func give(_ n: Int, _ out: OpaquePointer?) { margin_port_out_int(out, Int64(n)) }

    // An answer: its readiness and deadline typed, its JSON read only when it has more.
    private func call(_ make: (UnsafeMutablePointer<MarginSessionStatus>, UnsafeMutablePointer<Int>) -> UnsafeMutablePointer<UInt8>?) -> JSONObject {
        var status = MarginSessionStatus(ready: false, deadline: .nan)
        var len = 0
        var out: JSONObject = [:]
        if let p = make(&status, &len) {
            out = (try? JSONSerialization.jsonObject(with: Data(bytesNoCopy: p, count: len, deallocator: .none))) as? JSONObject ?? [:]
            margin_buffer_free(p, len)
        }
        out["deadline"] = status.deadline.isNaN ? NSNull() : status.deadline
        if status.ready { out["ready"] = true }
        return out
    }

    private func bytes<T>(_ value: Any, _ body: (UnsafePointer<UInt8>?, Int) -> T) -> T {
        let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("null".utf8)
        return data.withUnsafeBytes { body($0.bindMemory(to: UInt8.self).baseAddress, $0.count) }
    }

    func input(_ input: JSONObject) -> JSONObject {
        guard JSONSerialization.isValidJSONObject(input) else { return ["error": "the input isn't JSON"] }
        return bytes(input) { p, n in call { margin_session_input(core, p, n, $0, $1) } }
    }

    func answer(_ id: UInt64, _ reply: JSONObject) -> JSONObject {
        let reply = JSONSerialization.isValidJSONObject(reply) ? reply : ["error": "the answer isn't JSON"]
        return bytes(reply) { p, n in call { margin_session_answer(core, id, p, n, $0, $1) } }
    }

    func tick(_ due: Double) -> JSONObject { call { margin_session_tick(core, due, $0, $1) } }

    // A field's rows, typed.
    private final class Rows { var rows: [CoreRow] = [] }
    func rows(_ f: Field) -> [CoreRow] {
        let sink = Rows()
        withExtendedLifetime(sink) {
            margin_session_rows(core, f.rawValue, Unmanaged.passUnretained(sink).toOpaque()) { ctx, row in
                guard let ctx, let r = row?.pointee else { return }
                let c = CoreRow(i0: Int(r.i0), f: r.f, b0: r.b0, b1: r.b1, s0: SessionCore.text(r.s0), s1: SessionCore.text(r.s1), s2: SessionCore.text(r.s2))
                MainActor.assumeIsolated { Unmanaged<Rows>.fromOpaque(ctx).takeUnretainedValue().rows.append(c) }
            }
        }
        return sink.rows
    }

    // One row of a field put or (`del`) taken out: the field's revision after it.
    @discardableResult func edit(_ f: Field, del: Bool, _ r: CoreRow) -> UInt64 {
        var rev: UInt64 = 0
        Self.with(r.s0) { s0 in
            Self.with(r.s1) { s1 in
                Self.with(r.s2) { s2 in
                    var row = MarginRow(i0: Int64(r.i0), f: r.f, b0: r.b0, b1: r.b1, s0: s0, s1: s1, s2: s2)
                    _ = margin_session_edit_row(core, f.rawValue, del, &row, &rev)
                }
            }
        }
        return rev
    }
    private static func with(_ s: String?, _ body: (MarginBytes) -> Void) {
        guard var s else { return body(MarginBytes(ptr: nil, len: 0)) }
        s.withUTF8 { body(MarginBytes(ptr: $0.baseAddress ?? UnsafePointer(bitPattern: 1), len: $0.count)) }
    }

    var done: [String] { KeysCore.answer { margin_session_done(core, $0) } as? [String] ?? [] }
    var idle: Bool { margin_session_idle(core) }
    func rev(_ field: Field) -> UInt64 { margin_session_rev(core, field.rawValue) }
    // A show waiting on a profile's link still wanted (the Safari waker's look), a new app's open still wanted (the
    // engine's): typed, nothing allocated.
    func linkWanted(_ profile: String) -> Bool { KeysCore.bytes(profile) { margin_session_link_wanted(core, $0, $1) } }
    func openWanted(window: Int, item: String) -> Bool { KeysCore.bytes(item) { margin_session_open_wanted(core, Int64(window), $0, $1) } }
}
