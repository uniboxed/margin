// The lasting data on the link (DATA.md "Messages"): each copy's data.hello,
// data.snapshot and data.changes taken into its own profile's data set
// (DataStore.swift), and the app's answers: data.need, data.snapshot (in
// parts, none over 1 MB), data.changes and data.ack. A message only ever
// touches the set of the link it came on (its browser and profile: a
// `profile` naming another is refused).
//
//  - data.hello: the queue merged into the profile's set, stored, the set sent
//    back (data.snapshot), then data.ack. If the copy's `rev` is the set's
//    rev from before the merge (it has every item the app had), no snapshot:
//    the queue's changes that lost come back in data.changes, then data.ack
//    with the new rev. With no set for the profile, or one
//    older than what the app confirmed to it (`acked` above the set's: the
//    files restored from a backup, or a write lost), data.need { all: true }
//    instead, and the queue is held until the copy's data.snapshot comes.
//  - data.snapshot from the copy (the converter's, first link): with no set,
//    stored as the profile's, then data.ack; with one, merged in, stored,
//    sent back merged, then data.ack.
//  - data.changes from the copy: merged, stored, data.ack; a change that lost
//    to the app's newer item gets that item back (data.changes).
//  - the app's own changes (change()): merged, stored, sent to the copy if linked.
//  - data.ack's upTo: the newest updatedAt among the copy's changes stored,
//    never lower than the copy's acked. Sent only once they're on disk.
//  - `rev` (the stored set's revision, DataStore.Stored.rev) goes on the
//    snapshot's part 0, and on data.ack once the link is in step (the copy
//    has had a snapshot, or matched the rev on hello): with everything the
//    app sent before it applied, the copy then has the set at that rev.
//
// A profile's set carried to a new id (a signing change gives every named
// Safari profile a new one: ShellProfiles.swift carryOver): carry(from:to:).
// Before data.need for a profile with no set, `beforeNeed` is asked: it can
// hold the hello up to `holdFor` (a Safari read may yet map the id), or name
// the set to carry over at once.
//
// The read API for the rest of the app (the overlay's UI, step 4): profiles(),
// set(of:), values(_:of:), marginTabs(of:), and onChange.

import Foundation

// One copy's end of the link, as the data needs it (LinkConnection; the unit tests' stand-in).
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

final class DataSync {
    // What one link is in the middle of.
    final class Linked {
        weak var peer: DataPeer?
        var awaiting = false // data.need sent, the copy's data.snapshot not here yet
        var held: [DataChange] = [] // its queue and changes while awaiting
        var helloAcked: Double = 0
        var ackedSent: Double = 0
        var transfer: String?
        var parts: [Int: JSONObject] = [:]
        var partsCount = 0
        // The copy has every item of the app's set, but for what the app sent
        // it since (in order) and its own changes still queued: acks carry the rev.
        var synced = false
        // A data.hello held before data.need (beforeNeed said .hold), and the hold's end.
        var heldHello: JSONObject?
        var holdTimer: Timer?
        var carrying = false // carry(from:to:) under way for it
        var heldChanges: [DataChange] = [] // the copy's data.changes meanwhile
        init(_ peer: DataPeer) { self.peer = peer }
    }

    // What to do for a profile that has no set, before asking its copy for one.
    enum NeedChoice {
        case ask // data.need, as always
        case hold // wait up to holdFor for carry(from:to:) or release(_:)
        case carry(from: DataProfile, why: String) // that set is this profile's: carried over at once
    }

    let store: DataStore
    // The items' JSON in one message from the app, at most (the envelope fits in the rest of 1 MB).
    var partBytes = 900_000
    // A profile's set changed (on disk): which collections.
    var onChange: ((DataProfile, Set<String>) -> Void)?
    private var linked: [DataProfile: Linked] = [:]
    // Messages the app couldn't send (over 1 MB, the link down): tests read it.
    private(set) var unsent = 0
    var beforeNeed: ((DataProfile) -> NeedChoice)?
    var holdFor: TimeInterval = 3
    // A set carried over (old, new, why), and a profile's first set stored from its copy.
    var onCarried: ((DataProfile, DataProfile, String) -> Void)?
    var onFirstSet: ((DataProfile) -> Void)?
    var now: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() }

    init(store: DataStore) {
        self.store = store
    }

    // ---- the read API ----

    // Every profile with a data set (of one browser, or all), linked or not.
    func profiles(browser: String? = nil) -> [DataProfile] { store.profiles(browser: browser) }

    func set(of p: DataProfile) -> DataSet? { store.load(p)?.set }

    // A collection's live values: { id: value }.
    func values(_ collection: String, of p: DataProfile) -> [String: Any] { set(of: p)?.liveValues(collection) ?? [:] }

    // The profile's Margin tabs, open or not, newest first (highest `order`).
    func marginTabs(of p: DataProfile, space: String? = nil) -> [(id: String, value: JSONObject)] {
        values("tabs", of: p).compactMap { id, v -> (id: String, value: JSONObject)? in
            guard let v = v as? JSONObject, space == nil || v["spaceId"] as? String == space else { return nil }
            return (id, v)
        }.sorted { (num($0.value["order"]) ?? 0, $1.id) > (num($1.value["order"]) ?? 0, $0.id) }
    }

    func isLinked(_ p: DataProfile) -> Bool { linked[p]?.peer?.isUp == true }

    // ---- the app's own changes ----

    // Merged into the profile's set, stored, and sent to its copy if it's
    // linked. False if the profile has no set.
    @discardableResult func change(_ p: DataProfile, _ changes: [DataChange]) -> Bool {
        guard let stored = store.load(p) else { return false }
        var set = stored.set
        let won = set.merge(changes)
        let applied = zip(changes, won).filter(\.1).map(\.0)
        guard !applied.isEmpty else { return true }
        save(p, set, acked: stored.acked, changed: Set(applied.map(\.collection))) { [weak self] _ in
            guard let self, let l = self.linked[p], !l.awaiting else { return }
            self.sendChanges(l, applied)
        }
        return true
    }

    // ---- the link ----

    func linkUp(_ peer: DataPeer) {
        linked[peer.hello.dataProfile] = Linked(peer)
    }

    func linkDown(_ peer: DataPeer) {
        let p = peer.hello.dataProfile
        if linked[p]?.peer === peer || linked[p]?.peer == nil {
            linked[p]?.holdTimer?.invalidate()
            linked[p] = nil
        }
    }

    // The profiles whose data.hello is held (beforeNeed's .hold).
    var holding: [DataProfile] { linked.filter { $0.value.heldHello != nil && !$0.value.carrying }.map(\.key).sorted() }

    // A held hello let go: data.need, as without the hold.
    func release(_ p: DataProfile, why: String) {
        guard let l = linked[p], !l.carrying, let body = l.heldHello else { return }
        l.heldHello = nil
        l.holdTimer?.invalidate()
        l.holdTimer = nil
        Diagnostics.note("\(p): data.hello no longer held (\(why))")
        hello(l, p, body, hold: false)
        takeHeldChanges(l, p)
    }

    // The copy's changes that came while its hello was held, taken as they would have been.
    private func takeHeldChanges(_ l: Linked, _ p: DataProfile) {
        guard !l.heldChanges.isEmpty else { return }
        let list = l.heldChanges
        l.heldChanges = []
        changes(l, p, ["changes": list.map(\.json)])
    }

    func received(_ peer: DataPeer, _ kind: String, _ body: JSONObject) {
        let p = peer.hello.dataProfile
        guard let l = linked[p], l.peer === peer else { return }
        if let named = body["profile"], named as? String != peer.hello.profile {
            return Diagnostics.warn("\(p): \(kind) for another profile (\(named)): refused")
        }
        if let epoch = body["epoch"], epoch as? String != peer.hello.epoch { return }
        switch kind {
        case "data.hello": hello(l, p, body)
        case "data.snapshot": snapshot(l, p, body)
        case "data.changes": changes(l, p, body)
        default: Diagnostics.note("\(p): \(kind) isn't known: left")
        }
    }

    private func hello(_ l: Linked, _ p: DataProfile, _ body: JSONObject, hold: Bool = true) {
        guard (int(body["format"]) ?? DataFormat.version) == DataFormat.version else {
            return Diagnostics.warn("\(p): data.hello of format \(body["format"] ?? "?"): left")
        }
        let acked = max(0, num(body["acked"]).flatMap { $0.isFinite ? $0 : nil } ?? 0)
        let queue = DataChange.list(body["queue"])
        l.helloAcked = acked
        l.ackedSent = acked
        l.transfer = nil
        l.parts = [:]
        if hold, store.load(p) == nil, let choice = beforeNeed?(p) {
            switch choice {
            case .ask: break
            case .hold:
                if l.heldHello == nil {
                    Diagnostics.note("\(p): no data set, and no Safari profile maps it yet: data.hello held up to \(holdFor) s for Safari's profiles to be read")
                    l.holdTimer?.invalidate()
                    l.holdTimer = Timer.scheduledTimer(withTimeInterval: holdFor, repeats: false) { [weak self] _ in
                        MainActor.assumeIsolated { self?.release(p, why: "no Safari read mapped it within \(self?.holdFor ?? 0) s") }
                    }
                }
                l.heldHello = body
                return
            case .carry(let from, let why):
                l.heldHello = body
                if carry(from: from, to: p, why: why) { return }
                l.heldHello = nil
            }
        }
        guard let stored = store.load(p), acked <= stored.acked else {
            if let stored = store.load(p) {
                Diagnostics.warn("\(p): the copy has \(Int(acked)) confirmed, the app's files only \(Int(stored.acked)): the whole set asked for")
            } else {
                Diagnostics.note("\(p): no data set yet: the whole set asked for")
            }
            l.awaiting = true
            l.held = queue
            send(l, "data.need", ["all": true])
            return
        }
        l.awaiting = false
        l.held = []
        // The copy has every item the app has (it says the set's rev): only what its queue lost goes back.
        let inStep = (body["rev"] as? String).map { !$0.isEmpty && $0 == stored.rev } ?? false
        var set = stored.set
        let won = set.merge(queue)
        let upTo = max(acked, queue.map(\.item.updatedAt).max() ?? 0)
        let lost = Self.keys(zip(queue, won).filter { !$0.1 }.map(\.0))
        Diagnostics.note("\(p): data.hello, \(queue.count) queued (\(won.filter { $0 }.count) taken), \(inStep ? "the copy has the app's set: no snapshot" : "the set sent back")")
        save(p, set, acked: max(stored.acked, upTo), changed: Set(zip(queue, won).filter(\.1).map(\.0.collection))) { [weak self] rev in
            guard let self else { return }
            var sent: String?
            if inStep { self.answer(l, p, lost) } else { sent = self.sendSet(l, p) }
            l.synced = true
            self.sendAck(l, upTo, rev: sent ?? rev) // a snapshot is of the set now: its rev
        }
    }

    // "collection\0id" for each change (the ones that lost, to answer).
    private static func keys(_ changes: [DataChange]) -> Set<String> {
        Set(changes.map { "\($0.collection)\u{0}\($0.id)" })
    }

    // The app's items for changes of the copy's that lost to them, in data.changes.
    private func answer(_ l: Linked, _ p: DataProfile, _ lost: Set<String>) {
        let now = store.load(p)?.set
        let back = lost.sorted().compactMap { key -> DataChange? in
            let parts = key.split(separator: "\u{0}", maxSplits: 1).map(String.init)
            guard parts.count == 2, let item = now?.item(parts[0], parts[1]) else { return nil }
            return DataChange(collection: parts[0], id: parts[1], item: item)
        }
        if !back.isEmpty { sendChanges(l, back) }
    }

    private func snapshot(_ l: Linked, _ p: DataProfile, _ body: JSONObject) {
        guard (int(body["format"]) ?? DataFormat.version) == DataFormat.version,
              let set = body["set"] as? JSONObject, (int(set["format"]) ?? DataFormat.version) == DataFormat.version else {
            return Diagnostics.warn("\(p): a data.snapshot that isn't format \(DataFormat.version)'s: left")
        }
        let piece = set["items"] as? JSONObject ?? [:]
        var whole = piece
        if let parts = int(body["parts"]) {
            guard let part = int(body["part"]), (1...10_000).contains(parts), (0..<parts).contains(part) else {
                return Diagnostics.warn("\(p): a data.snapshot part that doesn't add up: left")
            }
            let transfer = body["transfer"] as? String
            if l.transfer != transfer || l.partsCount != parts {
                l.transfer = transfer
                l.partsCount = parts
                l.parts = [:]
            }
            l.parts[part] = piece
            guard l.parts.count == parts else { return }
            whole = [:]
            for i in 0..<parts {
                for (collection, list) in l.parts[i] ?? [:] {
                    var into = whole[collection] as? JSONObject ?? [:]
                    if let list = list as? JSONObject { into.merge(list) { _, b in b } }
                    whole[collection] = into
                }
            }
            l.transfer = nil
            l.parts = [:]
        }
        let incoming = DataSet(json: ["items": whole])
        let stored = store.load(p)
        var merged = stored?.set ?? DataSet()
        merged.merge(l.held)
        merged.merge(incoming.changes())
        for collection in incoming.items.keys where merged.items[collection] == nil { merged.items[collection] = [:] }
        let upTo = max(l.helloAcked, l.held.map(\.item.updatedAt).max() ?? 0, incoming.newest)
        l.awaiting = false
        l.held = []
        Diagnostics.note("\(p): data.snapshot from the copy (\(incoming.items.values.map(\.count).reduce(0, +)) items)\(stored == nil ? ": the profile's first data set" : "")")
        save(p, merged, acked: max(stored?.acked ?? 0, upTo), changed: nil) { [weak self] rev in
            guard let self else { return }
            let sent = stored != nil ? self.sendSet(l, p) : nil // the copy lacks what the app had
            l.synced = true
            self.sendAck(l, upTo, rev: sent ?? rev)
            if stored == nil { self.onFirstSet?(p) }
        }
    }

    private func changes(_ l: Linked, _ p: DataProfile, _ body: JSONObject) {
        let changes = DataChange.list(body["changes"])
        guard !changes.isEmpty else { return }
        // Its hello held (or being carried over): kept, and taken once the hello is answered.
        if l.heldHello != nil || l.carrying {
            l.heldChanges += changes
            return
        }
        guard !l.awaiting, let stored = store.load(p) else {
            l.held += changes
            if !l.awaiting {
                l.awaiting = true
                send(l, "data.need", ["all": true])
            }
            return
        }
        var set = stored.set
        let won = set.merge(changes)
        let lost = Self.keys(zip(changes, won).filter { !$0.1 }.map(\.0))
        let upTo = max(l.ackedSent, changes.map(\.item.updatedAt).max() ?? 0)
        save(p, set, acked: max(stored.acked, upTo), changed: Set(zip(changes, won).filter(\.1).map(\.0.collection))) { [weak self] rev in
            guard let self else { return }
            self.answer(l, p, lost) // the app's newer items, for the changes that lost to them
            self.sendAck(l, upTo, rev: rev)
        }
    }

    // ---- carried over ----

    // `old`'s set becomes `new`'s (the same browser profile under a new id:
    // a signing change). Only while `old` isn't linked, and only if `new` has
    // no set or just its first, untouched one (rev 1: stored from its copy's
    // snapshot, nothing changed since), and its copy isn't sending one now.
    // `new`'s own items that `old`'s set doesn't have (the new copy's fresh
    // defaults, in its first set or its held hello's queue) become deletions,
    // so its copy ends up with `old`'s set alone; items both have stay
    // `old`'s (a fresh copy's defaults are newer, and would win). Stored,
    // then `old`'s folder put away (DataStore.archive), then the copy told:
    // its held hello answered as a relink, or the set sent to it. True if it's
    // under way.
    @discardableResult func carry(from old: DataProfile, to new: DataProfile, why: String) -> Bool {
        guard old != new, old.browser == new.browser, !isLinked(old), let source = store.load(old) else { return false }
        let target = store.load(new)
        if let target, !target.rev.hasPrefix("1-") { return false } // changed since its first set: it's the person's now
        let l = linked[new]
        if l?.awaiting == true { return false } // its copy's snapshot is on its way: after it's stored (onFirstSet)
        if l?.carrying == true { return false }
        let held = l?.heldHello
        var set = source.set
        let t = now()
        var theirs: [(collection: String, id: String, at: Double)] = []
        for (c, list) in target?.set.items ?? [:] { for (id, item) in list where !item.deleted { theirs.append((c, id, item.updatedAt)) } }
        for change in DataChange.list(held?["queue"]) where !change.item.deleted { theirs.append((change.collection, change.id, change.item.updatedAt)) }
        var dropped = 0
        for item in theirs where set.items[item.collection]?[item.id] == nil {
            set.items[item.collection, default: [:]][item.id] = .tombstone(max(t, item.at + 1))
            dropped += 1
        }
        for c in target?.set.collections ?? [] where set.items[c] == nil { set.items[c] = [:] }
        let acked = max(source.acked, target?.acked ?? 0)
        let items = source.set.items.values.map { $0.values.filter { !$0.deleted }.count }.reduce(0, +)
        l?.carrying = true
        save(new, set, acked: acked, changed: nil) { [weak self] _ in
            guard let self else { return }
            l?.carrying = false
            let archived = self.store.archive(old)
            Diagnostics.note("\(new.browser): \(old.profile) → \(new.profile) (\(why)): data carried over (\(items) items\(dropped > 0 ? ", \(dropped) of the new copy's own left out" : ""); the old set \(archived == nil ? "not put away" : "put away"))")
            self.onCarried?(old, new, why)
            guard let l = self.linked[new], l.peer != nil else { return }
            if let body = l.heldHello {
                // The held hello answered as a relink with nothing queued: the set goes to the copy.
                l.heldHello = nil
                l.holdTimer?.invalidate()
                l.holdTimer = nil
                var b = body
                b["queue"] = [Any]()
                self.hello(l, new, b, hold: false)
            } else if !l.awaiting {
                let sent = self.sendSet(l, new)
                self.sendAck(l, l.ackedSent, rev: sent ?? self.store.savedRev)
            }
            self.takeHeldChanges(l, new)
        }
        return true
    }

    // ---- storing ----

    // `then` gets the rev this save wrote.
    private func save(_ p: DataProfile, _ set: DataSet, acked: Double, changed: Set<String>?, then: @escaping (String) -> Void) {
        store.save(p, DataStore.Stored(set: set, acked: acked), changed: changed) { [weak self] ok in
            guard let self else { return }
            guard ok else { return Diagnostics.warn("\(p): not stored: nothing confirmed to the copy") }
            let rev = self.store.savedRev
            if !(changed?.isEmpty ?? false) { self.onChange?(p, changed ?? Set(set.collections)) }
            then(rev)
        }
    }

    // ---- sending ----

    private func send(_ l: Linked, _ kind: String, _ body: JSONObject) {
        guard let peer = l.peer, peer.isUp else { unsent += 1; return }
        var body = body
        body["profile"] = peer.hello.profile
        body["epoch"] = peer.hello.epoch
        if !peer.sendData(kind, body) {
            unsent += 1
            Diagnostics.warn("\(peer.hello.dataProfile): \(kind) not sent")
        }
    }

    // With the rev only while the link is in step: then the copy has the set at that rev.
    private func sendAck(_ l: Linked, _ upTo: Double, rev: String) {
        l.ackedSent = max(l.ackedSent, upTo)
        send(l, "data.ack", l.synced ? ["upTo": upTo, "rev": rev] : ["upTo": upTo])
    }

    // The profile's whole set as it is now, in parts. Its rev.
    @discardableResult private func sendSet(_ l: Linked, _ p: DataProfile) -> String? {
        guard let stored = store.load(p) else { return nil }
        let set = stored.set
        let (parts, omitted) = Self.parts(of: set, budget: partBytes)
        let transfer = UUID().uuidString.lowercased()
        for (i, items) in parts.enumerated() {
            var body: JSONObject = ["format": DataFormat.version, "set": ["format": DataFormat.version, "items": items], "transfer": transfer, "part": i, "parts": parts.count]
            if i == 0 {
                body["rev"] = stored.rev
                if !omitted.isEmpty { body["omitted"] = omitted.map { [$0.collection, $0.id] } }
            }
            send(l, "data.snapshot", body)
        }
        if !omitted.isEmpty { Diagnostics.warn("\(p): \(omitted.count) items too big for a message left out of data.snapshot") }
        return stored.rev
    }

    private func sendChanges(_ l: Linked, _ changes: [DataChange]) {
        let (batches, omitted) = Self.batches(of: changes, budget: partBytes)
        for batch in batches { send(l, "data.changes", ["changes": batch]) }
        if !omitted.isEmpty { Diagnostics.warn("\(omitted.count) changes too big for a message not sent") }
    }

    // A set's items in parts of at most `budget` bytes of JSON, split by
    // collection and item; every collection named in the first part (an empty
    // one too: the copy then knows it's empty). An item bigger than the budget
    // alone is left out (omitted).
    static func parts(of set: DataSet, budget: Int) -> (parts: [JSONObject], omitted: [(collection: String, id: String)]) {
        var parts: [JSONObject] = []
        var current: JSONObject = Dictionary(uniqueKeysWithValues: set.collections.map { ($0, JSONObject()) })
        var size = set.collections.reduce(16) { $0 + $1.utf8.count + 8 }
        var omitted: [(collection: String, id: String)] = []
        for collection in set.collections {
            let list = set.items[collection] ?? [:]
            for id in list.keys.sorted() {
                let json = list[id]!.json
                let bytes = (jsonText(json)?.count ?? 0) + id.utf8.count * 2 + 8
                if bytes + collection.utf8.count + 64 > budget {
                    omitted.append((collection, id))
                    continue
                }
                let opening = current[collection] == nil ? collection.utf8.count + 8 : 0
                if size + bytes + opening > budget {
                    parts.append(current)
                    current = [:]
                    size = 16
                }
                if current[collection] == nil { size += collection.utf8.count + 8 }
                var into = current[collection] as? JSONObject ?? [:]
                into[id] = json
                current[collection] = into
                size += bytes
            }
        }
        parts.append(current)
        return (parts, omitted)
    }

    // Changes in batches of at most `budget` bytes of JSON, in order.
    static func batches(of changes: [DataChange], budget: Int) -> (batches: [[JSONObject]], omitted: [DataChange]) {
        var batches: [[JSONObject]] = []
        var current: [JSONObject] = []
        var size = 16
        var omitted: [DataChange] = []
        for change in changes {
            let json = change.json
            let bytes = (jsonText(json)?.count ?? 0) + 2
            if bytes + 64 > budget {
                omitted.append(change)
                continue
            }
            if size + bytes > budget, !current.isEmpty {
                batches.append(current)
                current = []
                size = 16
            }
            current.append(json)
            size += bytes
        }
        if !current.isEmpty { batches.append(current) }
        return (batches, omitted)
    }
}
