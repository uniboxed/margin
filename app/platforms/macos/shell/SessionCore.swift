// margin-core's session object (margin-ffi's `margin_session_*`, docs/CORE-REFACTOR.md step 3) as HostedSession calls
// it: JSON in and out for the rare calls, typed reads for the revisions, idle and the log. Its ports call the session
// (`owner`) synchronously during a call, on the main thread, and may call back in.

import Foundation
import MarginCore

final class SessionCore {
    private var core: OpaquePointer?
    private let library: Library // (its object the session reads in place: kept as long as the session)
    private let box = Box()
    private final class Box { weak var owner: HostedSession? }
    var owner: HostedSession? {
        get { box.owner }
        set { box.owner = newValue }
    }

    // The fields with a revision (session/state.rs `Field`).
    enum Field: UInt32 { case shown = 0, open, safariWindows, done }

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
            })
        }
    }

    deinit { margin_session_free(core) }

    private func call(_ make: (UnsafeMutablePointer<Int>) -> UnsafeMutablePointer<UInt8>?) -> JSONObject {
        KeysCore.answer(make) as? JSONObject ?? [:]
    }

    func input(_ input: JSONObject) -> JSONObject {
        guard JSONSerialization.isValidJSONObject(input) else { return ["error": "the input isn't JSON"] }
        return KeysCore.bytes(KeysCore.json(input)) { p, n in call { margin_session_input(core, p, n, $0) } }
    }

    func answer(_ id: UInt64, _ reply: JSONObject) -> JSONObject {
        let reply = JSONSerialization.isValidJSONObject(reply) ? reply : ["error": "the answer isn't JSON"]
        return KeysCore.bytes(KeysCore.json(reply)) { p, n in call { margin_session_answer(core, id, p, n, $0) } }
    }

    func tick(_ due: Double) -> JSONObject { call { margin_session_tick(core, due, $0) } }

    var done: [String] { KeysCore.answer { margin_session_done(core, $0) } as? [String] ?? [] }
    var idle: Bool { margin_session_idle(core) }
    func rev(_ field: Field) -> UInt64 { margin_session_rev(core, field.rawValue) }
}
