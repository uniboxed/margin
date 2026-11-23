// A browser's profiles as Margin.app knows them (docs/DATA.md): margin-core's `data::profiles`
// (app/shared/core/src/data/profiles.rs, the one copy of the rules: the file, the slots rule, the names, Safari's
// names mapped to the copies, the carry after a signing change; docs/CORE-REFACTOR.md step 1.4), through margin-ffi's
// profiles object. One file per browser, beside its profiles' data sets:
//
//   data/<browser>/browser.json
//     { format, browser, order: [[profile, space]], profiles: { id: info }, savedAt }
//
// This file keeps the Mac's side only: the API the rest of the app calls, what Safari's profiles were read as
// (SafariProfiles.swift reads Safari's own folder, and stays the Mac's) handed in as JSON, `now` handed in with each
// call, and the core's log lines written to Diagnostics. The core never calls back.
//
// What it holds (the core's doc says why): `stored`, every profile's spaces in the order last resolved against the
// sets (read once by the library's import, Library.importOnce, through resolve(), the slots rule); each profile's name
// (Safari's own with the folder grant or Full Disk Access, which win; else a name typed in an earlier version's Edit
// Profile; else "Default" / "Profile N"; a profile deleted in Safari keeps the name Safari last gave it, as typed);
// a profile under a new id after a signing change (carrySource, mightCarry, carry).

import Foundation
import MarginCore

nonisolated struct SpaceKey: Hashable, Comparable, CustomStringConvertible {
    let profile: String
    let space: String
    var description: String { "\(profile)/\(space)" }
    static func < (a: SpaceKey, b: SpaceKey) -> Bool { (a.profile, a.space) < (b.profile, b.space) }
}

// A profile as the core keeps it (read from its answer).
struct ProfileInfo: Equatable {
    var name = ""
    var named = false // the person named it (an earlier version's Edit Profile), or Safari did before it deleted the profile
    var firstSeen: Double = 0
    var lastSeen: Double = 0 // linked last (or now, while it is)
    var hidden = false // forgotten: left out until its copy links again
    var browserId = "" // the browser's own id for the profile, once its name was read (Safari: its server_id)
    var browserName = "" // the name the browser last gave it

    init() {}
    init(json o: JSONObject) {
        name = o["name"] as? String ?? ""
        named = o["named"] as? Bool ?? false
        firstSeen = num(o["firstSeen"]) ?? 0
        lastSeen = num(o["lastSeen"]) ?? 0
        hidden = o["hidden"] as? Bool ?? false
        browserId = o["browserId"] as? String ?? ""
        browserName = o["browserName"] as? String ?? ""
    }
}

final class BrowserProfiles {
    static let defaultProfile = "s-default"

    let browser: String
    var now: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() }
    nonisolated struct BrowserName: Equatable { var name: String }
    // One of the browser's profiles as last read, as the core keeps it.
    nonisolated struct Read: Equatable { var serverId: String; var name: String; var margin: String? }

    private var core: OpaquePointer?

    // `root`: the data folder (DataSync.root); nil keeps it in memory (the unit tests).
    init(browser: String, root: URL?) {
        self.browser = browser
        core = KeysCore.bytes(browser) { b, bn in
            guard let root else { return margin_profiles_new(b, bn, nil, 0) }
            return KeysCore.bytes(root.path) { r, rn in margin_profiles_new(b, bn, r, rn) }
        }
    }

    deinit { margin_profiles_free(core) }

    // One request to the core (with `now`), its answer; its log lines written, an error answer said.
    @discardableResult private func call(_ request: JSONObject) -> JSONObject {
        var request = request
        request["now"] = now()
        let answer = KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_profiles_call(core, p, n, $0) } } as? JSONObject ?? [:]
        for line in answer["log"] as? [JSONObject] ?? [] {
            guard let text = line["text"] as? String else { continue }
            if line["warn"] as? Bool == true { Diagnostics.warn(text) } else { Diagnostics.note(text) }
        }
        if let error = answer["error"] as? String { Diagnostics.warn("\(browser) profiles: \(error)") }
        return answer
    }

    private static func keys(_ value: Any?) -> [SpaceKey] {
        (value as? [[Any]] ?? []).compactMap { e in
            guard e.count == 2, let p = e[0] as? String, let s = e[1] as? String else { return nil }
            return SpaceKey(profile: p, space: s)
        }
    }

    func save() { call(["type": "save"]) }

    // Every profile's spaces in the order last resolved against the sets (refresh).
    var stored: [SpaceKey] { Self.keys(call(["type": "stored"])["stored"]) }
    var info: [String: ProfileInfo] {
        var out: [String: ProfileInfo] = [:]
        for (id, value) in call(["type": "info"])["info"] as? JSONObject ?? [:] {
            if let value = value as? JSONObject { out[id] = ProfileInfo(json: value) }
        }
        return out
    }
    var saves: Int { call(["type": "saves"])["saves"] as? Int ?? 0 }

    // ---- profiles ----

    // Every profile Margin knows, in the order it first saw them (hidden ones too).
    var profiles: [String] { call(["type": "profiles"])["profiles"] as? [String] ?? [] }
    func defaultName(_ profile: String) -> String { call(["type": "defaultName", "profile": profile])["name"] as? String ?? "" }
    func name(_ profile: String) -> String { call(["type": "name", "profile": profile])["name"] as? String ?? "" }

    // Forgotten (its set was carried to the profile's new id: carry): its spaces leave the order at the next refresh.
    @discardableResult func forget(_ profile: String) -> Bool { call(["type": "forget", "profile": profile])["forgotten"] as? Bool == true }

    // ---- the browser's own names ----

    // The browser's own names now (with the permission; not saved as such): profile → name.
    var browserNames: [String: BrowserName] {
        (call(["type": "browserNames"])["names"] as? JSONObject ?? [:]).compactMapValues { ($0 as? String).map(BrowserName.init(name:)) }
    }
    // The browser's profiles as last read (nil: none read, or no permission any more).
    var browserRead: [Read]? {
        (call(["type": "browserRead"])["read"] as? [JSONObject]).map { list in
            list.map { Read(serverId: $0["serverId"] as? String ?? "", name: $0["name"] as? String ?? "", margin: $0["margin"] as? String) }
        }
    }

    // What Safari has now (SafariProfiles.read). True if a name shown changed.
    @discardableResult func useBrowserNames(_ list: [SafariProfile]) -> Bool {
        let read: [JSONObject] = list.map { p in
            var o: JSONObject = ["serverId": p.serverId, "name": p.name]
            if let margin = p.margin { o["margin"] = margin }
            return o
        }
        return call(["type": "useBrowserNames", "list": read])["changed"] as? Bool == true
    }

    // Linked copies with Safari's own ids that no profile in the last read maps to: said in the log once each. The ids said.
    @discardableResult func checkMapped(_ linked: Set<String>) -> [String] {
        call(["type": "checkMapped", "linked": linked.sorted()])["said"] as? [String] ?? []
    }

    // No names from the browser (no permission, or none readable): the typed ones again.
    @discardableResult func dropBrowserNames() -> Bool { call(["type": "dropBrowserNames"])["changed"] as? Bool == true }

    // ---- a profile under a new id (a signing change) ----

    // The set to carry to `new` (the core's rule); `withSets`: the browser's profiles with a set on disk.
    func carrySource(for new: String, withSets: Set<String>, linked: Set<String>) -> (old: String, browserId: String)? {
        let answer = call(["type": "carrySource", "new": new, "withSets": withSets.sorted(), "linked": linked.sorted()])
        guard let old = answer["old"] as? String else { return nil }
        return (old, answer["browserId"] as? String ?? "")
    }

    // Worth waiting for a read before a new copy's first set (the core's rule).
    func mightCarry(_ new: String, withSets: Set<String>, linked: Set<String>) -> Bool {
        call(["type": "mightCarry", "new": new, "withSets": withSets.sorted(), "linked": linked.sorted()])["might"] as? Bool == true
    }

    // `old`'s place taken by `new`: its name, first sight and places in the order; `old` forgotten.
    func carry(from old: String, to new: String) { call(["type": "carry", "old": old, "new": new]) }

    // ---- the order ----

    // The profiles' spaces as their sets have them now (each profile's in its own order) and which profiles are
    // linked: the order resolved, new profiles taken in, the linked ones seen now. True when saved.
    @discardableResult func refresh(spaces: [String: [String]], linked: Set<String>) -> Bool {
        call(["type": "refresh", "spaces": spaces, "linked": linked.sorted()])["changed"] as? Bool == true
    }

    // The slots rule. `spaces`: each profile's space ids in its own order; `profiles`: in the order Margin first saw them.
    static func resolve(stored: [SpaceKey], spaces: [String: [String]], profiles: [String]) -> [SpaceKey] {
        let request: JSONObject = ["stored": stored.map { [$0.profile, $0.space] }, "spaces": spaces, "profiles": profiles]
        let answer = KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_profiles_resolve(p, n, $0) } } as? JSONObject ?? [:]
        if let error = answer["error"] as? String { Diagnostics.warn("profiles: \(error)") }
        return keys(answer["order"])
    }
}
