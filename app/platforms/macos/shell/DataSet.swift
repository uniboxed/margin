// Margin's lasting data set (docs/DATA.md) in Swift: items, changes and the merge.
// The rules are extension/shared/data-merge.ts mergeData's (the reference),
// and the Swift store runs the same JSON vectors (tests/fixtures/data-merge/):
//
//  - an item is { updatedAt, value } or a tombstone { updatedAt, deleted: true };
//  - per item, the later updatedAt wins; on the same time a deletion wins over
//    a live item, otherwise the change wins over what was there;
//  - changes apply in the order given;
//  - collections and items the merge doesn't know are kept as they are; a
//    malformed change is skipped, a malformed item in the base dropped.
//
// Values are kept as JSONSerialization gives them (any JSON: NSNull for null).

import Foundation

enum DataFormat {
    static let version = 1
    // Tombstones are kept 60 days, at most 2,000 per collection (docs/DATA.md).
    static let tombstoneMs: Double = 60 * 24 * 3600 * 1000
    static let tombstoneCap = 2000
}

// JSON's true (a number 1 isn't).
func isTrue(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
    return n.boolValue
}

// A collection's or an item's name: 1–256 UTF-16 units, as the reference counts them.
func isDataName(_ v: Any?) -> Bool {
    guard let s = v as? String else { return false }
    return (1...256).contains(s.utf16.count)
}

struct DataItem {
    let updatedAt: Double
    // nil: a tombstone. A JSON null is NSNull.
    let value: Any?
    var deleted: Bool { value == nil }

    init(updatedAt: Double, value: Any) {
        self.updatedAt = updatedAt
        self.value = value
    }

    private init(tombstone at: Double) {
        updatedAt = at
        value = nil
    }

    static func tombstone(_ at: Double) -> DataItem { DataItem(tombstone: at) }

    // isItem: an object with a finite updatedAt, and either deleted: true and
    // no value, or a value and no `deleted` at all.
    init?(json: Any?) {
        guard let o = json as? JSONObject, let at = num(o["updatedAt"]), at.isFinite else { return nil }
        if isTrue(o["deleted"]) {
            guard o["value"] == nil else { return nil }
            self.init(tombstone: at)
        } else {
            guard o["deleted"] == nil, let value = o["value"] else { return nil }
            self.init(updatedAt: at, value: value)
        }
    }

    var json: JSONObject {
        if let value { return ["updatedAt": updatedAt, "value": value] }
        return ["updatedAt": updatedAt, "deleted": true]
    }

    // Whether `self`, coming in, replaces `current` (docs/DATA.md "The merge").
    func wins(over current: DataItem?) -> Bool {
        guard let current else { return true }
        if updatedAt != current.updatedAt { return updatedAt > current.updatedAt }
        if current.deleted && !deleted { return false } // a deletion holds its ground
        return true // the same time: the change wins
    }
}

struct DataChange {
    let collection: String
    let id: String
    let item: DataItem

    init(collection: String, id: String, item: DataItem) {
        (self.collection, self.id, self.item) = (collection, id, item)
    }

    // isChange: a collection and an id (1–256 characters), a finite updatedAt,
    // and a value or deleted: true (not both, nothing else in `deleted`).
    init?(json: Any?) {
        guard let o = json as? JSONObject, isDataName(o["collection"]), isDataName(o["id"]),
              let collection = o["collection"] as? String, let id = o["id"] as? String else { return nil }
        guard let item = DataItem(json: o) else { return nil } // its updatedAt, value and deleted, as an item's
        self.init(collection: collection, id: id, item: item)
    }

    var json: JSONObject {
        var out = item.json
        out["collection"] = collection
        out["id"] = id
        return out
    }

    static func list(_ json: Any?) -> [DataChange] {
        (json as? [Any] ?? []).compactMap { DataChange(json: $0) }
    }
}

struct DataSet {
    // collection → id → item
    var items: [String: [String: DataItem]] = [:]

    init() {}

    // A data set as JSON ({ format, items }): collections that aren't objects
    // and items that aren't items are dropped (mergeData's base).
    init(json: Any?) {
        guard let o = json as? JSONObject, let collections = o["items"] as? JSONObject else { return }
        for (collection, list) in collections {
            guard let list = list as? JSONObject else { continue }
            var kept: [String: DataItem] = [:]
            for (id, raw) in list { if let item = DataItem(json: raw) { kept[id] = item } }
            items[collection] = kept
        }
    }

    var json: JSONObject {
        ["format": DataFormat.version, "items": items.mapValues { $0.mapValues(\.json) }]
    }

    var collections: [String] { items.keys.sorted() }
    var isEmpty: Bool { items.values.allSatisfy(\.isEmpty) }

    func item(_ collection: String, _ id: String) -> DataItem? { items[collection]?[id] }

    // Each change in order: whether it won (it's now the item).
    @discardableResult mutating func merge(_ changes: [DataChange]) -> [Bool] {
        changes.map { change in
            guard change.item.wins(over: items[change.collection]?[change.id]) else { return false }
            items[change.collection, default: [:]][change.id] = change.item
            return true
        }
    }

    // mergeData(base, changes), from JSON as the vectors give it.
    static func merge(_ base: Any?, _ changes: Any?) -> DataSet {
        var set = DataSet(json: base)
        set.merge(DataChange.list(changes))
        return set
    }

    // Every item as a change (changesFrom): by collection, then id.
    func changes() -> [DataChange] {
        collections.flatMap { collection in
            (items[collection] ?? [:]).keys.sorted().map { DataChange(collection: collection, id: $0, item: items[collection]![$0]!) }
        }
    }

    // A collection's live items' values (liveValues).
    func liveValues(_ collection: String) -> [String: Any] {
        (items[collection] ?? [:]).compactMapValues(\.value)
    }

    // The newest updatedAt in the set (0 if none).
    var newest: Double { items.values.flatMap(\.values).map(\.updatedAt).max() ?? 0 }

    // Without tombstones older than `before`, and at most `cap` per collection
    // (the newest kept). Returns the collections that lost any.
    @discardableResult mutating func pruneTombstones(before: Double, cap: Int = DataFormat.tombstoneCap) -> Set<String> {
        var touched: Set<String> = []
        for (collection, list) in items {
            let tombstones = list.filter { $0.value.deleted }.sorted { $0.value.updatedAt > $1.value.updatedAt || ($0.value.updatedAt == $1.value.updatedAt && $0.key < $1.key) }
            let drop = tombstones.enumerated().filter { $0.offset >= cap || $0.element.value.updatedAt < before }.map(\.element.key)
            guard !drop.isEmpty else { continue }
            for id in drop { items[collection]![id] = nil }
            touched.insert(collection)
        }
        return touched
    }
}
