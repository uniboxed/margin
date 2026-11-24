// Margin.app's lasting data, one set per browser profile (docs/DATA.md; PLAN.md §6 "Where data lives"): margin-core's
// data sync over its store (app/shared/core/src/data/: the files and their backups, the merge, the link's data
// messages, the hold and the carry; docs/CORE-REFACTOR.md step 1.2-1.3), through margin-ffi's data object. This file
// keeps the Mac's side: each link's connection (the core's sends go to the one with their epoch), the store's writer
// waking the main thread, the hold's timer, and the callbacks the rest of the app had (`onChange`, `onFirstSet`,
// `onCarried`, `beforeNeed`). Nothing is confirmed to a copy before its data is on disk: the core acts on a save once
// its writer says it's written.

import Foundation
import MarginCore

struct DataProfile: Hashable, Comparable, CustomStringConvertible {
    let browser: String
    let profile: String
    var key: String { "\(browser):\(profile)" }
    var description: String { key }
    static func < (a: DataProfile, b: DataProfile) -> Bool { a.key < b.key }
}

// One change's shape for the core, as on the link (`{ collection, id, updatedAt, value }`, a deletion with
// `deleted: true` and no value: margin-core's DataChange::from_json).
struct DataItem {
    let updatedAt: Double
    let value: Any?
    let deleted: Bool
    init(updatedAt: Double, value: Any) { self.updatedAt = updatedAt; self.value = value; deleted = false }
    private init(tombstone at: Double) { updatedAt = at; value = nil; deleted = true }
    static func tombstone(_ at: Double) -> DataItem { DataItem(tombstone: at) }
    var json: JSONObject { deleted ? ["updatedAt": updatedAt, "deleted": true] : ["updatedAt": updatedAt, "value": value ?? NSNull()] }
}

struct DataChange {
    let collection: String
    let id: String
    let item: DataItem
    var json: JSONObject {
        var out = item.json
        out["collection"] = collection
        out["id"] = id
        return out
    }
}

protocol DataPeer: AnyObject {
    var hello: LinkMessage.Hello { get }
    var isUp: Bool { get }
    @discardableResult func sendData(_ kind: String, _ body: JSONObject) -> Bool
}

extension LinkConnection: DataPeer {
    func sendData(_ kind: String, _ body: JSONObject) -> Bool { send(.data(kind: kind, body: body)) }
}

extension LinkMessage.Hello {
    var dataProfile: DataProfile { DataProfile(browser: browser, profile: profile) }
}

// A name as the store writes it on disk (the core's rule: a–z, 0–9, _ and - as they are, the rest %XX).
enum DataNames {
    static func fileName(_ name: String) -> String {
        KeysCore.bytes(name) { p, n in KeysCore.answer { margin_data_file_name(p, n, $0) } } as? String ?? name
    }
}

final class DataSync {
    enum NeedChoice {
        case ask // data.need, as always
        case hold // wait up to holdFor for carry(from:to:) or release(_:)
        case carry(from: DataProfile, why: String) // that set is this profile's: carried over at once
    }

    // ~/Library/Application Support/Margin/data
    static var appRoot: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Margin/data", isDirectory: true)
    }

    let root: URL
    var onChange: ((DataProfile, Set<String>) -> Void)?
    // The choice for a profile with no set yet: the profile, and the profiles of its browser that have a set on disk
    // (everything the choice needs: it never asks the data back mid-call).
    var beforeNeed: ((DataProfile, Set<String>) -> NeedChoice)?
    var onCarried: ((DataProfile, DataProfile, String) -> Void)?
    var onFirstSet: ((DataProfile) -> Void)?
    var holdFor: TimeInterval = 3 { didSet { _ = call(["type": "configure", "holdFor": holdFor]) } }
    var partBytes = 900_000 { didSet { _ = call(["type": "configure", "partBytes": partBytes]) } }

    private var core: OpaquePointer?
    // The core's data object, for the library's import (margin_library_import reads its sets, then lets it go).
    var corePointer: OpaquePointer? { core }
    private let box = Box()
    private var peers: [String: WeakPeer] = [:]
    private var holdTimer: Timer?
    private var peerDown = 0 // sends whose link was down here (the core counts the rest)

    private final class Box { weak var sync: DataSync? }
    private struct WeakPeer { weak var peer: DataPeer? }
    private static func peerKey(_ browser: String, _ profile: String, _ epoch: String) -> String { "\(browser)\u{0}\(profile)\u{0}\(epoch)" }

    // `background`: written on the store's own thread, the main thread told after (false: at once, the unit tests).
    init(root: URL, background: Bool = true) {
        self.root = root
        box.sync = self
        let ctx = Unmanaged.passUnretained(box).toOpaque()
        core = KeysCore.bytes(root.path) { p, n in
            margin_data_new(p, n, background, ctx, { ctx in
                // (The writer's thread: the box kept for the hop, then the main thread drains what's written.)
                guard let ctx else { return }
                let box = Unmanaged<Box>.fromOpaque(ctx).retain()
                DispatchQueue.main.async { MainActor.assumeIsolated { box.takeRetainedValue().sync?.written() } }
            }, { ctx, question, len, outLen in
                guard let ctx, let question, let outLen else { return nil }
                let q = (try? JSONSerialization.jsonObject(with: Data(bytes: question, count: len))) as? JSONObject ?? [:]
                let p = DataProfile(browser: q["browser"] as? String ?? "", profile: q["profile"] as? String ?? "")
                let withSets = Set(q["withSets"] as? [String] ?? [])
                let choice = MainActor.assumeIsolated { Unmanaged<Box>.fromOpaque(ctx).takeUnretainedValue().sync?.beforeNeed?(p, withSets) } ?? .ask
                let answer: JSONObject
                switch choice {
                case .ask: answer = ["choice": "ask"]
                case .hold: answer = ["choice": "hold"]
                case .carry(let from, let why): answer = ["choice": "carry", "from": from.profile, "why": why]
                }
                guard let data = try? JSONSerialization.data(withJSONObject: answer), let out = malloc(data.count) else { return nil }
                data.copyBytes(to: out.assumingMemoryBound(to: UInt8.self), count: data.count)
                outLen.pointee = data.count
                return out.assumingMemoryBound(to: UInt8.self)
            })
        }
    }

    deinit {
        holdTimer?.invalidate()
        margin_data_free(core)
    }

    // The calls since this object was made that may have changed a set (every one but the reads): what a copy of what
    // it reads (DataSetWindowSource's drawn text) is checked against, so it's made again after any change, written yet
    // or not.
    private(set) var changes = 0
    private static let reads: Set<String> = ["profiles", "set", "values", "linked", "unsent", "holding", "nextHold", "root"]

    // One request to the core, its answer (an error answer said once).
    private func call(_ request: JSONObject) -> JSONObject {
        if !Self.reads.contains(request["type"] as? String ?? "") { changes &+= 1 }
        let answer = KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_data_call(core, p, n, $0) } } as? JSONObject ?? [:]
        if let error = answer["error"] as? String { Diagnostics.warn("data: \(error)") }
        return answer
    }

    // What the core said to do: its log, its sends (each on the link with its epoch), then the callbacks.
    private func apply(_ fx: JSONObject) {
        for line in fx["log"] as? [JSONObject] ?? [] {
            guard let text = line["text"] as? String else { continue }
            if line["warn"] as? Bool == true { Diagnostics.warn(text) } else { Diagnostics.note(text) }
        }
        for s in fx["send"] as? [JSONObject] ?? [] {
            guard var message = s["message"] as? JSONObject, let browser = s["browser"] as? String, let profile = s["profile"] as? String, let epoch = s["epoch"] as? String else { continue }
            guard let peer = peers[Self.peerKey(browser, profile, epoch)]?.peer, peer.isUp else { peerDown += 1; continue }
            let kind = message.removeValue(forKey: "k") as? String ?? ""
            if !peer.sendData(kind, message) { peerDown += 1 }
        }
        func profile(_ o: JSONObject, _ key: String = "profile") -> DataProfile { DataProfile(browser: o["browser"] as? String ?? "", profile: o[key] as? String ?? "") }
        for c in fx["changed"] as? [JSONObject] ?? [] { onChange?(profile(c), Set(c["collections"] as? [String] ?? [])) }
        for f in fx["firstSet"] as? [JSONObject] ?? [] { onFirstSet?(profile(f)) }
        for c in fx["carried"] as? [JSONObject] ?? [] { onCarried?(profile(c, "old"), profile(c, "new"), c["why"] as? String ?? "") }
        scheduleHold()
    }

    // The hold's end, if a hello is held: a tick then.
    private func scheduleHold() {
        holdTimer?.invalidate()
        holdTimer = nil
        guard let at = num(call(["type": "nextHold"])["at"]) else { return }
        let wait = max(0, (at - Date().timeIntervalSince1970 * 1000) / 1000)
        holdTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; self.apply(self.call(["type": "tick"])) }
        }
    }

    // The saves written since (the writer's wake): what each was for.
    func written() { apply(call(["type": "written"])) }

    // ---- the read API ----

    func profiles(browser: String? = nil) -> [DataProfile] {
        var request: JSONObject = ["type": "profiles"]
        if let browser { request["browser"] = browser }
        return (call(request)["profiles"] as? [JSONObject] ?? []).map { DataProfile(browser: $0["browser"] as? String ?? "", profile: $0["profile"] as? String ?? "") }
    }

    // The profile's set (`{ collection: { id: item } }`), nil if it has none.
    func set(of p: DataProfile) -> JSONObject? { call(["type": "set", "browser": p.browser, "profile": p.profile])["set"] as? JSONObject }

    // The profile's set as stored: its items, what it confirmed to its copy (`acked`) and its revision; nil if none.
    func stored(_ p: DataProfile) -> (items: JSONObject, acked: Double, rev: String)? {
        let answer = call(["type": "set", "browser": p.browser, "profile": p.profile])
        guard let items = answer["set"] as? JSONObject else { return nil }
        return (items, num(answer["acked"]) ?? 0, answer["rev"] as? String ?? "")
    }

    // A collection's live values: `{ id: value }`.
    func values(_ collection: String, of p: DataProfile) -> JSONObject {
        call(["type": "values", "collection": collection, "browser": p.browser, "profile": p.profile])["values"] as? JSONObject ?? [:]
    }

    func isLinked(_ p: DataProfile) -> Bool { call(["type": "linked", "browser": p.browser, "profile": p.profile])["linked"] as? Bool == true }
    var unsent: Int { (call(["type": "unsent"])["unsent"] as? Int ?? 0) + peerDown }
    var holding: [DataProfile] {
        (call(["type": "holding"])["holding"] as? [JSONObject] ?? []).map { DataProfile(browser: $0["browser"] as? String ?? "", profile: $0["profile"] as? String ?? "") }
    }

    // ---- the app's own changes ----

    // Merged into the profile's set, stored, and sent to its copy if it's linked. False if the profile has no set.
    @discardableResult func change(_ p: DataProfile, _ changes: [DataChange]) -> Bool {
        let answer = call(["type": "change", "browser": p.browser, "profile": p.profile, "changes": changes.map(\.json)])
        if answer["noSet"] as? Bool == true { return false }
        apply(answer)
        return true
    }

    // ---- the link ----

    func linkUp(_ peer: DataPeer) {
        let h = peer.hello
        peers[Self.peerKey(h.browser, h.profile, h.epoch)] = WeakPeer(peer: peer)
        apply(call(["type": "linkUp", "browser": h.browser, "profile": h.profile, "epoch": h.epoch]))
    }

    func linkDown(_ peer: DataPeer) {
        let h = peer.hello
        apply(call(["type": "linkDown", "browser": h.browser, "profile": h.profile, "epoch": h.epoch]))
        peers[Self.peerKey(h.browser, h.profile, h.epoch)] = nil
    }

    // A data message from a link (`kind`: data.hello, data.snapshot, data.changes).
    func received(_ peer: DataPeer, _ kind: String, _ body: JSONObject) {
        let h = peer.hello
        var message = body
        message["k"] = kind
        apply(call(["type": "received", "browser": h.browser, "profile": h.profile, "epoch": h.epoch, "message": message]))
    }

    // A held hello let go (data.need, as without the hold).
    func release(_ p: DataProfile, why: String) { apply(call(["type": "release", "browser": p.browser, "profile": p.profile, "why": why])) }

    // `old`'s set becomes `new`'s (a signing change's new id): false if it can't be.
    @discardableResult func carry(from old: DataProfile, to new: DataProfile, why: String) -> Bool {
        let answer = call(["type": "carry", "browser": new.browser, "old": old.profile, "new": new.profile, "why": why])
        if answer["refused"] as? Bool == true { return false }
        apply(answer)
        return true
    }

    // A test's fixed clock (ms) for the store and the sync.
    func testClock(_ ms: Double) { _ = call(["type": "configure", "now": ms]) }
}
