// Margin.app's copy of one extension copy's state: storage.local's keys, as
// the extension sends them (a snapshot, then deltas: app/PROTOCOL.md), each
// kept as the JSON it came as. An overlay's page gets the whole state from
// here at once (no round trip, so nothing to wait for before it draws); the
// app itself reads only the little it needs (value(_:)). From
// feat/native-panel, with the window list read here too.
//
// One mirror per link (per browser profile): `epoch` is the copy's for this
// connection, and nothing from another epoch is taken. Snapshots, deltas and window lists
// count up together (`seq`, from 1 each epoch); on the link they come in
// order, so a number missed is a bug somewhere, and the state is asked for
// whole again (`.gap`: a resync), with what comes before it left.

import Foundation

final class StateMirror {
    enum Outcome: Equatable {
        case applied
        // Another epoch's, or the state is being asked for again (a resync).
        case ignored
        // A number missed: ask for the state again (until it comes, the rest is ignored).
        case gap(expected: Int, got: Int)
    }

    private(set) var epoch: String?
    private(set) var seq = 0
    // The copy of Margin whose ids the state has (its hello).
    private(set) var origin: String?
    private(set) var since: Double?
    private(set) var windows: [JSONObject] = []
    private var values: [String: Data] = [:]
    // The site icons by origin (deltas send only those that changed).
    private var favicons: [String: Data] = [:]
    private var hasFavicons = false
    private var snapshotted = false
    private var resyncing = false

    var hasState: Bool { snapshotted }
    // A number missed, and the snapshot asked for not yet come.
    var isResyncing: Bool { resyncing }

    // A new connection: nothing from before it is kept.
    func begin(_ hello: LinkMessage.Hello) {
        reset()
        epoch = hello.epoch
        origin = hello.origin
        since = hello.since
    }

    // A snapshot is asked for again (after a gap): until it comes, deltas are left.
    func askAgain() {
        resyncing = true
    }

    func reset() {
        epoch = nil
        origin = nil
        since = nil
        seq = 0
        windows = []
        values = [:]
        favicons = [:]
        hasFavicons = false
        snapshotted = false
        resyncing = false
    }

    func apply(_ message: LinkMessage) -> Outcome {
        switch message {
        case .snapshot(let epoch, let seq, let state, let windows):
            guard epoch == self.epoch else { return .ignored }
            values = [:]
            favicons = [:]
            hasFavicons = false
            for (key, value) in state {
                if key == "favicons", let icons = value as? JSONObject {
                    hasFavicons = true
                    for (site, entry) in icons { favicons[site] = jsonText(entry) }
                } else if let json = jsonText(value) {
                    values[key] = json
                }
            }
            self.windows = windows
            self.seq = seq
            snapshotted = true
            resyncing = false
            return .applied
        case .delta(let epoch, let seq, let changes, let icons):
            let outcome = next(epoch, seq)
            guard outcome == .applied else { return outcome }
            for (key, change) in changes where key != "favicons" {
                switch change {
                case .set(let value): values[key] = jsonText(value)
                case .removed: values[key] = nil
                }
            }
            if let icons {
                hasFavicons = true
                for (site, entry) in icons.set { favicons[site] = jsonText(entry) }
                for site in icons.del { favicons[site] = nil }
            }
            return .applied
        case .windows(let epoch, let seq, let list):
            let outcome = next(epoch, seq)
            guard outcome == .applied else { return outcome }
            windows = list
            return .applied
        default:
            return .ignored
        }
    }

    // Whether a delta or window list numbered `seq` follows on (counted if so).
    private func next(_ epoch: String, _ seq: Int) -> Outcome {
        guard epoch == self.epoch, !resyncing else { return .ignored }
        guard snapshotted, seq == self.seq + 1 else {
            resyncing = true
            return .gap(expected: self.seq + 1, got: seq)
        }
        self.seq = seq
        return .applied
    }

    // The whole state as one JSON object (storage.local's keys, as a panel's
    // fromStorage reads them); nil before the first snapshot.
    func stateJSON() -> Data? {
        guard snapshotted else { return nil }
        var entries = values
        if hasFavicons { entries["favicons"] = object(favicons) }
        return object(entries)
    }

    // One stored key, read (for the app's own use).
    func value(_ key: String) -> Any? {
        if key == "favicons" { return hasFavicons ? (try? JSONSerialization.jsonObject(with: object(favicons))) : nil }
        return values[key].flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }
    }

    var keys: [String] { (Array(values.keys) + (hasFavicons ? ["favicons"] : [])).sorted() }

    // {"key":json,…}, from JSON already made.
    private func object(_ parts: [String: Data]) -> Data {
        var out = Data("{".utf8)
        for (i, key) in parts.keys.sorted().enumerated() {
            if i > 0 { out.append(contentsOf: Array(",".utf8)) }
            out.append(jsonText(key) ?? Data("\"\"".utf8))
            out.append(contentsOf: Array(":".utf8))
            out.append(parts[key]!)
        }
        out.append(contentsOf: Array("}".utf8))
        return out
    }
}
