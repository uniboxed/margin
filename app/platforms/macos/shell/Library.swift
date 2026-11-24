// Margin.app's library (docs/MARGIN-APP.md, phase 1; DECISIONS.md "Margin.app owns the spaces"): the person's spaces, pins, folders and Margin tabs ("items") are the app's, in one data set
// of its own, not each profile's copy's:
//
//   data/app/set.json, data/app/items/<collection>.json   (margin-core's store, flat: one set, no profiles)
//
// Collections: spaces (name, emoji, color, order, browser, profile: the Safari profile its new web items open in),
// pins, folders, tabs (the items: a web page in a browser's profile, or a Mac app by its bundle id: `target`),
// archive, windows (each Margin window's space), imports (the import's marker). Ids are the library's own; what was
// imported is namespaced by its browser and profile (app/shared/library/library.ts nsId), so two profiles' spaces
// never meet.
//
// Every edit goes through perform(action, payload): the rules are the extension's (LibraryRules.swift runs them),
// which answer with the values that changed; the library times them (now, or just after the item's own time),
// merges them as any change (margin-core's data/library.rs), stores them and tells its observers. What needs a browser or an app
// (showing an item, opening an address, closing a page) is a request for the hosting phase: recorded (`requests`)
// and given to the delegate if there is one. Nothing here opens, shows or closes anything.

import Foundation
import MarginCore
import Security

// Where an item (or a pin, or an archive entry) opens: a browser's profile, or a Mac app.
enum ItemTarget: Hashable {
    case web(browser: String, profile: String?) // profile nil: the browser's default
    case app(bundleId: String, name: String)
    case margin(page: String) // one of Margin's own pages (library.ts MARGIN_PAGES), drawn in Margin's window: nothing hosted

    static let marginPages: Set<String> = ["settings"]

    // Read with the core's rules (session/target.rs: the default browser, an empty profile, the pages there are), from
    // the shape it writes back.
    init?(json: Any?) {
        guard let o = json as? JSONObject, JSONSerialization.isValidJSONObject(o),
              let t = SessionRules.call(["rule": "target", "target": o])["target"] as? JSONObject else { return nil }
        switch t["kind"] as? String {
        case "web":
            guard let browser = t["browser"] as? String else { return nil }
            self = .web(browser: browser, profile: t["profile"] as? String)
        case "app":
            guard let id = t["bundleId"] as? String, let name = t["name"] as? String else { return nil }
            self = .app(bundleId: id, name: name)
        case "margin":
            guard let page = t["page"] as? String else { return nil }
            self = .margin(page: page)
        default: return nil
        }
    }

    var json: JSONObject {
        switch self {
        case .web(let browser, let profile): return ["kind": "web", "browser": browser, "profile": profile ?? NSNull()]
        case .app(let bundleId, let name): return ["kind": "app", "bundleId": bundleId, "name": name]
        case .margin(let page): return ["kind": "margin", "page": page]
        }
    }
}

// Something an action asks of the hosting: `type` is the action's (activateTab, newTab, closeTab, setSpace, openPin,
// unpin, clearToday, restoreArchive), `body` all it said (library.ts Request).
struct LibraryRequest {
    let type: String
    let body: JSONObject
    var windowId: Int? { int(body["windowId"]) }
    var item: String? { body["item"] as? String }
    var url: String? { body["url"] as? String }
    var spaceId: String? { body["spaceId"] as? String }
    var target: ItemTarget? { ItemTarget(json: body["target"]) }
}

// The hosting phase's end: it shows, opens and closes what the library's requests name.
protocol LibraryDelegate: AnyObject {
    func library(_ library: Library, wants request: LibraryRequest)
}

struct LibraryOutcome {
    let ok: Bool
    let result: Any? // the action's answer (library.ts), NSNull for none
    let error: String?
    let changed: Set<String> // the collections it changed
    let requests: [LibraryRequest]
}

// JSON's true (a number 1 isn't): the rules' `ok`.
private func isTrue(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
    return n.boolValue
}

final class Library {
    static let collections = ["spaces", "pins", "favorites", "airTraffic", "splits", "folders", "tabs", "archive", "windows", "imports"]
    // The set's key in its store (the store is flat: the key names no folder).
    static let key = DataProfile(browser: "app", profile: "library")
    static let requestsKept = 100
    static let scriptName = "library.js"

    // The library's set as margin-core keeps it (its flat store, the entries' times, the merge: data/library.rs), and
    // every collection's live values as the core last gave them (refreshed for what a change of its own touched: the
    // reads below never ask the core).
    private let core: LibraryCore
    private var cache: [String: JSONObject] = [:]
    let rules: LibraryRules
    weak var delegate: LibraryDelegate?
    // The requests made, oldest first, the last requestsKept of them.
    private(set) var requests: [LibraryRequest] = []
    var now: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() }
    // Random letters for the ids an action makes (a test gives its own).
    var randomIds: () -> [String] = { (0..<4).map { _ in Library.randomLetters() } }
    private var observers: [Int: (Set<String>) -> Void] = [:]
    private var nextObserver = 0

    // data/app under the lasting data's root (DataSync.appRoot, or a test's folder).
    static func folder(in dataRoot: URL) -> URL { dataRoot.appendingPathComponent("app", isDirectory: true) }

    // margin-core's library object, for the session's reads of it (SessionCore: it lives as long as this library).
    var corePointer: OpaquePointer? { core.pointer }

    // The library in `root` (its flat store's folder), written in the background (false: at once, the unit tests).
    init(root: URL, background: Bool = true, rules: LibraryRules) {
        core = LibraryCore(root: root, background: background)
        self.rules = rules
        cache = core.values()
    }

    // The library in `dataRoot`/app with the rules from `script`; nil if the rules can't run.
    static func open(dataRoot: URL, script: URL, background: Bool = true) -> Library? {
        guard let rules = LibraryRules.load(from: script) else { return nil }
        return Library(root: folder(in: dataRoot), background: background, rules: rules)
    }

    // ---- reading ----

    // A collection's live values: { id: value }.
    func liveValues(_ collection: String) -> JSONObject { cache[collection] ?? [:] }

    // Every collection's live values: { collection: { id: value } }.
    var values: JSONObject { Dictionary(uniqueKeysWithValues: Self.collections.map { ($0, liveValues($0) as Any) }) }

    var isImported: Bool { liveValues("imports")["done"] != nil }

    // What the UI draws (library.ts snapshot): its stored values' shape (app/shared/ui/host-app.ts, shared/stored.ts
    // fromStorage), the items as kept tabs with their targets, and `library: { v, imported }`.
    func snapshot() -> JSONObject {
        guard let o = rules.call("snapshot", [values]) as? JSONObject else {
            Diagnostics.warn("library: no snapshot: \(rules.lastError ?? "?")")
            return [:]
        }
        return o
    }

    // The actions perform() takes.
    var actions: [String] { rules.call("actions", []) as? [String] ?? [] }

    // The spaces in their order.
    func spaces() -> [(id: String, value: JSONObject)] {
        sortedValues("spaces") { (num($0.value["order"]) ?? 0, $0.id) < (num($1.value["order"]) ?? 0, $1.id) }
    }

    // The items (of a space, or all), newest first (highest `order`).
    func items(space: String? = nil) -> [(id: String, value: JSONObject)] {
        sortedValues("tabs") { (num($0.value["order"]) ?? 0, $1.id) > (num($1.value["order"]) ?? 0, $0.id) }
            .filter { space == nil || $0.value["spaceId"] as? String == space }
    }

    func target(ofItem id: String) -> ItemTarget? { ItemTarget(json: (liveValues("tabs")[id] as? JSONObject)?["target"]) }
    func space(ofItem id: String) -> String? { (liveValues("tabs")[id] as? JSONObject)?["spaceId"] as? String }

    // A split (docs/PEEK-SPLIT.md §4): its panes (items, in its order: those still there) and its axis; nil: none, or
    // fewer than two panes left.
    struct Split: Equatable { let id: String; let panes: [String]; let vertical: Bool }
    func split(_ id: String) -> Split? {
        guard let g = liveValues("splits")[id] as? JSONObject else { return nil }
        let items = liveValues("tabs")
        let panes = (g["panes"] as? [Any] ?? []).compactMap { $0 as? String }.filter { items[$0] != nil }
        return panes.count >= 2 ? Split(id: id, panes: panes, vertical: g["axis"] as? String == "vertical") : nil
    }
    func split(ofItem item: String) -> Split? {
        let all = liveValues("splits")
        for id in all.keys.sorted() where ((all[id] as? JSONObject)?["panes"] as? [Any])?.contains(where: { $0 as? String == item }) == true {
            if let s = split(id), s.panes.contains(item) { return s }
        }
        return nil
    }

    // The space a Margin window shows (nil: none chosen yet).
    func space(ofWindow windowId: Int) -> String? { (liveValues("windows")[String(windowId)] as? JSONObject)?["spaceId"] as? String }

    private func sortedValues(_ collection: String, by order: ((id: String, value: JSONObject), (id: String, value: JSONObject)) -> Bool) -> [(id: String, value: JSONObject)] {
        liveValues(collection).compactMap { id, v -> (id: String, value: JSONObject)? in (v as? JSONObject).map { (id, $0) } }.sorted(by: order)
    }

    // ---- watching ----

    // Called with the collections that changed, after each change (an action's, the import's). Its token, for stop.
    @discardableResult func observe(_ f: @escaping (Set<String>) -> Void) -> Int {
        nextObserver += 1
        observers[nextObserver] = f
        return nextObserver
    }

    func stopObserving(_ token: Int) { observers[token] = nil }

    // ---- editing ----

    // One of the UI's actions (or the hosting's: library.ts ACTIONS), with its payload as the UI sends it.
    @discardableResult func perform(_ action: String, _ payload: JSONObject = [:]) -> LibraryOutcome {
        let env: JSONObject = ["now": now(), "ids": randomIds()]
        guard let out = rules.call("perform", [values, action, payload, env]) as? JSONObject else {
            let why = rules.lastError ?? "no answer"
            Diagnostics.warn("library: \(action) failed: \(why)")
            return LibraryOutcome(ok: false, result: nil, error: why, changed: [], requests: [])
        }
        guard isTrue(out["ok"]) else {
            return LibraryOutcome(ok: false, result: nil, error: out["error"] as? String ?? "refused", changed: [], requests: [])
        }
        let changed = apply(out["changes"])
        let asked = (out["requests"] as? [Any] ?? []).compactMap { raw -> LibraryRequest? in
            guard let o = raw as? JSONObject, let type = o["type"] as? String else { return nil }
            return LibraryRequest(type: type, body: o)
        }
        for request in asked {
            requests.append(request)
            if requests.count > Self.requestsKept { requests.removeFirst(requests.count - Self.requestsKept) }
        }
        let outcome = LibraryOutcome(ok: true, result: out["result"], error: nil, changed: changed, requests: asked)
        for request in asked { delegate?.library(self, wants: request) }
        return outcome
    }

    // The rules' changes (values, untimed) as the set's: each at now, or just after the item's own time (a clock
    // that went back still makes a newer item), merged, stored, and the observers told. The collections changed.
    @discardableResult private func apply(_ raw: Any?) -> Set<String> {
        let entries = raw as? [Any] ?? []
        guard !entries.isEmpty else { return [] }
        let answer = core.apply(entries, at: now())
        let changed = Set(answer.changed)
        guard !changed.isEmpty else { return [] }
        for (collection, values) in answer.values { cache[collection] = values }
        for f in observers.sorted(by: { $0.key < $1.key }).map(\.value) { f(changed) }
        return changed
    }

    // ---- the import (decided by Tirth, 2026-11-15) ----

    // Once: every profile's data set the app keeps (`profiles`: the shell's store) into the library, each browser's
    // spaces in the person's order (data/<browser>/browser.json, read only: BrowserProfiles.resolve, the slots
    // rule), a forgotten profile's too (after the others: its data was never deleted). Its marker (`imports.done`)
    // goes in the same save as what it brought, and set.json is written last, so a crash before then runs it again,
    // which gives the same ids. Nothing in the profiles' files is written. False if it had run already or failed.
    @discardableResult func importOnce(from profiles: DataSync) -> Bool {
        guard !isImported else { return false }
        let all = profiles.profiles()
        let browsers = Set(all.map(\.browser)).sorted { ($0 == "safari" ? 0 : 1, $0) < ($1 == "safari" ? 0 : 1, $1) }
        var sets: [JSONObject] = []
        var order: [[String]] = []
        for browser in browsers {
            var spaces: [String: [String]] = [:]
            for p in all where p.browser == browser {
                guard profiles.set(of: p) != nil else { continue }
                let own = ["spaces", "pins", "folders", "tabs", "archive"]
                sets.append(["browser": browser, "profile": p.profile, "values": Dictionary(uniqueKeysWithValues: own.map { ($0, profiles.values($0, of: p) as Any) })])
                spaces[p.profile] = profiles.values("spaces", of: p).sorted {
                    (num(($0.value as? JSONObject)?["order"]) ?? 0, $0.key) < (num(($1.value as? JSONObject)?["order"]) ?? 0, $1.key)
                }.map(\.key)
            }
            let known = BrowserProfiles(browser: browser, root: profiles.root)
            order += BrowserProfiles.resolve(stored: known.stored, spaces: spaces, profiles: known.profiles).map { [browser, $0.profile, $0.space] }
        }
        guard let out = rules.call("importValues", [values, sets, order, ["now": now()]]) as? JSONObject else {
            Diagnostics.warn("library: the import failed: \(rules.lastError ?? "?")")
            return false
        }
        apply(out["changes"])
        let counts = (out["counts"] as? JSONObject ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
        Diagnostics.note("library: imported \(sets.count) profile set(s): \(counts)")
        return true
    }

    // ---- ids ----

    static func randomLetters(_ count: Int = 10) -> String {
        let letters = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return String(bytes.map { letters[Int($0) % letters.count] })
    }
}

// margin-core's library object (margin-ffi's `margin_library_*`): its store writes on a thread of its own and wakes the
// main thread, which drains what's written (a failed save said in the log).
final class LibraryCore {
    private var core: OpaquePointer?
    private let box = Box()
    private final class Box { weak var library: LibraryCore? }

    init(root: URL, background: Bool) {
        box.library = self
        let ctx = Unmanaged.passUnretained(box).toOpaque()
        core = KeysCore.bytes(root.path) { p, n in
            margin_library_new(p, n, background, ctx) { ctx in
                guard let ctx else { return }
                let box = Unmanaged<Box>.fromOpaque(ctx).retain()
                DispatchQueue.main.async { MainActor.assumeIsolated { box.takeRetainedValue().library?.written() } }
            }
        }
    }

    deinit { margin_library_free(core) }

    var pointer: OpaquePointer? { core }

    private func call(_ request: JSONObject) -> JSONObject {
        let answer = KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_library_call(core, p, n, $0) } } as? JSONObject ?? [:]
        if let error = answer["error"] as? String { Diagnostics.warn("library: \(error)") }
        for line in answer["log"] as? [JSONObject] ?? [] {
            guard let text = line["text"] as? String else { continue }
            if line["warn"] as? Bool == true { Diagnostics.warn(text) } else { Diagnostics.note(text) }
        }
        return answer
    }

    func values() -> [String: JSONObject] { call(["type": "values"])["values"] as? [String: JSONObject] ?? [:] }

    func apply(_ entries: [Any], at: Double) -> (changed: [String], values: [String: JSONObject]) {
        let answer = call(["type": "apply", "entries": entries, "at": at])
        return (answer["changed"] as? [String] ?? [], answer["values"] as? [String: JSONObject] ?? [:])
    }

    func written() { _ = call(["type": "written"]) }
}
