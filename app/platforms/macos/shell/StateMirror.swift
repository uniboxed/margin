// A linked copy's state as Margin.app reads it: storage.local's keys, as the extension sends them (a snapshot, then
// deltas: docs/PROTOCOL.md). The state itself is margin-core's (app/shared/core/src/mirror.rs, the one copy of its
// rules, kept per link by link_hub.rs; docs/CORE-REFACTOR.md step 1.6): each snapshot, delta and window list is applied
// inside the link's bytes call as it's read (one epoch per connection, nothing from another taken; the numbers count up
// together, and one missed is logged, the state asked for again at once and every 2 s until it comes). The link's
// answer says only what each did (LinkMessage.State: its keys, the windows when they changed, these flags), never the
// values again; this view keeps the flags and the windows (read on every poll), and reads a value from the core when
// the app needs one (its JSON as kept, read here once).

import Foundation

final class StateMirror {
    // A snapshot has come this epoch.
    private(set) var hasState = false
    // A number missed, and the snapshot asked for not yet come.
    private(set) var isResyncing = false
    // The copy's windows as its last snapshot or window list had them.
    private(set) var windows: [JSONObject] = []
    private let read: (String) -> Data?

    // `read`: one stored key's JSON as the core keeps it (nil: none).
    init(read: @escaping (String) -> Data?) { self.read = read }

    // What the core said a state message did.
    func applied(_ state: LinkMessage.State) {
        hasState = state.hasState
        isResyncing = state.resyncing
        if let list = state.windows { windows = list }
    }

    // One stored key, read (for the app's own use).
    func value(_ key: String) -> Any? {
        read(key).flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }
    }
}
