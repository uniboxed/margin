// A browser's profiles as Margin.app knows them (docs/DATA.md): each profile's name, when its copy was first and last
// linked, the browser's own id for it, and the order every profile's spaces were last in. One file per browser,
// beside its profiles' data sets:
//
//   data/<browser>/browser.json
//     { format, browser, order: [[profile, space]], profiles: { id: info }, savedAt }
//
// Margin is the app now (hosted only, 2026-11-16): the spaces the person sees and orders are the library's
// (Library.swift). What is left here is what hosting and the data still use:
//
// - `order` (`stored`), read once by the library's import (Library.importOnce) through resolve(), the slots rule: a
//   space no set has any more is left out; each profile's spaces fill the places its spaces had, in that profile's
//   own order (its spaces' `order`); a new space goes right after the one before it in its profile's order (the
//   first of its profile: before that profile's first); a profile not in the order yet comes last. Kept up to date
//   against the sets (refresh()); nothing moves a space in it any more (the cross-profile order, its moves, Edit
//   Profile and "Close windows to save memory" went with the overlay: 2026-11-17).
// - Profile names: with Full Disk Access, Safari's own (SafariProfiles.swift, `useBrowserNames`), kept in step with
//   Safari, which win over a typed one (Margin never writes to Safari): a profile's window is asked of Safari by that
//   name (ShellProfiles.swift openProfileWindow). Without it, a name typed in an earlier version's Edit Profile, else
//   "Default" for Safari's default profile (`s-default`) and "Profile N" for the others, in the order Margin first
//   saw them. A profile deleted in Safari keeps the name Safari last gave it, as if typed.
// - A profile under a new id after a signing change: its set carried over (carrySource, carry).

import Foundation

nonisolated struct SpaceKey: Hashable, Comparable, CustomStringConvertible {
    let profile: String
    let space: String
    var description: String { "\(profile)/\(space)" }
    static func < (a: SpaceKey, b: SpaceKey) -> Bool { (a.profile, a.space) < (b.profile, b.space) }
}

struct ProfileInfo: Equatable {
    var name = ""
    var named = false // the person named it (an earlier version's Edit Profile), or Safari did before it deleted the profile
    var firstSeen: Double = 0
    var lastSeen: Double = 0 // linked last (or now, while it is)
    var hidden = false // forgotten by the person: left out until its copy links again
    var browserId = "" // the browser's own id for the profile, once its name was read (Safari: its server_id)
    var browserName = "" // the name the browser last gave it

    var json: JSONObject {
        var o: JSONObject = ["name": name, "named": named, "firstSeen": firstSeen, "lastSeen": lastSeen, "hidden": hidden]
        if !browserId.isEmpty { o["browserId"] = browserId; o["browserName"] = browserName }
        return o
    }
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
    static let format = 1
    static let defaultProfile = "s-default"

    let browser: String
    let url: URL?
    var now: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() }
    private(set) var stored: [SpaceKey] = [] // every profile's spaces in the order last resolved against the sets (refresh)
    private(set) var info: [String: ProfileInfo] = [:]
    private(set) var saves = 0
    // The browser's own names now (with the permission; not saved as such): profile → name.
    private(set) var browserNames: [String: BrowserName] = [:]
    struct BrowserName: Equatable { var name: String }

    // `root`: the data folder (DataSync.root); nil keeps it in memory (the unit tests).
    init(browser: String, root: URL?) {
        self.browser = browser
        url = root?.appendingPathComponent(DataNames.fileName(browser), isDirectory: true).appendingPathComponent("browser.json")
        load()
    }

    private func load() {
        guard let url else { return }
        let data = (try? Data(contentsOf: url)) ?? (try? Data(contentsOf: URL(fileURLWithPath: url.path + ".bak")))
        guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject, int(o["format"]) == Self.format else { return }
        stored = (o["order"] as? [Any] ?? []).compactMap { entry in
            guard let pair = entry as? [Any], pair.count == 2, let p = pair[0] as? String, let s = pair[1] as? String else { return nil }
            return SpaceKey(profile: p, space: s)
        }
        for (id, value) in o["profiles"] as? JSONObject ?? [:] {
            if let value = value as? JSONObject { info[id] = ProfileInfo(json: value) }
        }
    }

    func save() {
        saves += 1
        guard let url else { return }
        let body: JSONObject = [
            "format": Self.format, "browser": browser, "savedAt": now(),
            "order": stored.map { [$0.profile, $0.space] },
            "profiles": info.mapValues(\.json),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { return }
        do { try AtomicFile.write(data, to: url) } catch { Diagnostics.warn("\(browser): browser.json not saved: \(error)") }
    }

    // ---- profiles ----

    // Every profile Margin knows, in the order it first saw them (hidden ones too).
    var profiles: [String] {
        info.keys.sorted { (info[$0]!.firstSeen, $0) < (info[$1]!.firstSeen, $1) }
    }

    func defaultName(_ profile: String) -> String {
        if profile == Self.defaultProfile { return "Default" }
        let others = profiles.filter { $0 != Self.defaultProfile }
        let n = (others.firstIndex(of: profile) ?? others.count) + (info[Self.defaultProfile] == nil ? 1 : 2)
        return "Profile \(n)"
    }

    func name(_ profile: String) -> String {
        if let b = browserNames[profile] { return b.name }
        let i = info[profile]
        return i?.named == true && !(i?.name.isEmpty ?? true) ? i!.name : defaultName(profile)
    }

    // Forgotten (its set was carried to the profile's new id: carry): its spaces leave the order at the next
    // refresh (its data stays) until its copy links again.
    @discardableResult func forget(_ profile: String) -> Bool {
        guard var i = info[profile], !i.hidden else { return false }
        i.hidden = true
        info[profile] = i
        save()
        return true
    }

    // ---- the browser's own names ----

    private var browserList: [SafariProfile]? // the browser's profiles as last read
    var browserRead: [SafariProfile]? { browserList }
    private var unmappedSaid: Set<String> = []

    // What the browser has now (SafariProfiles.read): each of its profiles that
    // Margin's copy runs in gets the browser's name and symbol; one linked
    // before (by `browserId`) keeps it while the browser still has that
    // profile, even if the copy's entry can't be read this time. A profile the
    // browser no longer has keeps its last name as a typed one (unless one was
    // typed). True if a name shown changed.
    @discardableResult func useBrowserNames(_ list: [SafariProfile]) -> Bool {
        browserList = list
        let before = browserNames
        if associate() { save() }
        return browserNames != before
    }

    // Linked copies with a browser's own id (`s-<uuid>`) that no profile in
    // the last read maps to: said in the log once each (again only after a
    // read has mapped it). Nothing before a read: no permission, a busy
    // database or no read yet says nothing about them. The ids said.
    @discardableResult func checkMapped(_ linked: Set<String>) -> [String] {
        guard let list = browserList else { return [] }
        let mapped = Set(list.compactMap(\.margin))
        unmappedSaid.subtract(mapped)
        var said: [String] = []
        for id in linked.sorted() where id.hasPrefix("s-") && id != Self.defaultProfile && !mapped.contains(id) && !unmappedSaid.contains(id) {
            unmappedSaid.insert(id)
            said.append(id)
            Diagnostics.note("\(browser): copy \(id) isn't any Safari profile's as read (\(list.count) profiles, copies \(mapped.sorted().joined(separator: ", ")))")
        }
        return said
    }

    // No names from the browser (no permission, or none readable): the typed ones again.
    @discardableResult func dropBrowserNames() -> Bool {
        browserList = nil
        guard !browserNames.isEmpty else { return false }
        browserNames = [:]
        return true
    }

    // The names from `browserList`, and each known profile's link to the
    // browser's (`browserId`, `browserName`) brought up to date. True if the
    // links changed (to be saved).
    private func associate() -> Bool {
        guard let list = browserList else { return false }
        var names: [String: BrowserName] = [:]
        var changed = false
        let byId = Dictionary(list.map { ($0.serverId, $0) }, uniquingKeysWith: { a, _ in a })
        for p in list where !p.name.isEmpty {
            if let margin = p.margin, names[margin] == nil { names[margin] = BrowserName(name: p.name) }
        }
        for id in info.keys.sorted() {
            guard var i = info[id] else { continue }
            let known = i.browserId.isEmpty ? nil : byId[i.browserId]
            if names[id] == nil, let known, !known.name.isEmpty { names[id] = BrowserName(name: known.name) }
            if let mapped = list.first(where: { $0.margin == id }) ?? known {
                guard i.browserId != mapped.serverId || i.browserName != mapped.name else { continue }
                i.browserId = mapped.serverId
                i.browserName = mapped.name
            } else if !i.browserId.isEmpty {
                // Deleted in the browser: the last name it gave stays, as if typed.
                Diagnostics.note("\(browser): profile “\(i.browserName)” (\(i.browserId)) is gone from the browser: \(id) keeps \(i.named ? "its typed name" : "that name")")
                if !i.named, !i.browserName.isEmpty { i.name = String(i.browserName.prefix(40)); i.named = true }
                i.browserId = ""
                i.browserName = ""
            } else {
                continue
            }
            info[id] = i
            changed = true
        }
        browserNames = names
        return changed
    }

    // ---- a profile under a new id (a signing change) ----

    // A build signed by another team (or unsigned) is a new extension to
    // Safari: each named profile's copy gets a new random id, so its spaces
    // would start fresh while the old set sits beside them as a profile with
    // no link. The browser's own id for the profile (`browserId`, kept from an
    // earlier read) ties the two: the set to carry to `new` is the one of a
    // known profile Margin linked to the same browser profile that the last
    // read maps `new` to, that has a set, and that isn't linked. Copies with
    // the browser's own ids only (`s-<uuid>`), never the default profile's.
    // With two such, the one linked last. Nil with no read (no permission).
    func carrySource(for new: String, hasSet: (String) -> Bool, linked: Set<String>) -> (old: String, browserId: String)? {
        guard Self.browserOwn(new), let list = browserList, let mapped = list.first(where: { $0.margin == new }) else { return nil }
        let current = Set(list.compactMap(\.margin))
        let old = info.filter { id, i in
            id != new && Self.browserOwn(id) && i.browserId == mapped.serverId && !current.contains(id) && !linked.contains(id) && hasSet(id)
        }.max { ($0.value.lastSeen, $1.key) < ($1.value.lastSeen, $0.key) }
        return old.map { ($0.key, mapped.serverId) }
    }

    // Worth waiting for a read before a new copy's first set: the last read
    // (there is one: the permission's given) doesn't map `new`, and a profile
    // linked to the browser's before has a set and isn't linked. That one may
    // still be mapped by the last read: Safari's plist may not say yet that
    // its entry was removed. The hold ends as soon as a read maps `new`.
    func mightCarry(_ new: String, hasSet: (String) -> Bool, linked: Set<String>) -> Bool {
        guard Self.browserOwn(new), let list = browserList, !list.contains(where: { $0.margin == new }) else { return false }
        return info.contains { id, i in id != new && Self.browserOwn(id) && !i.browserId.isEmpty && !linked.contains(id) && hasSet(id) }
    }

    private static func browserOwn(_ id: String) -> Bool { id.hasPrefix("s-") && id != defaultProfile }

    // `old`'s place taken by `new`: its name, when it was first seen and its
    // places in the order; `old` forgotten (its data set was put away). Its copy
    // linking again later (a switch back) brings it back, and the set is carried
    // back the same way.
    func carry(from old: String, to new: String) {
        guard old != new, let o = info[old] else { return }
        var n = info[new] ?? ProfileInfo()
        n.name = o.name
        n.named = o.named
        n.firstSeen = n.firstSeen == 0 ? o.firstSeen : min(n.firstSeen, o.firstSeen)
        n.lastSeen = max(n.lastSeen, o.lastSeen)
        n.hidden = false
        if n.browserId.isEmpty { (n.browserId, n.browserName) = (o.browserId, o.browserName) }
        info[new] = n
        var seen = Set<SpaceKey>()
        stored = stored.filter { $0.profile != new }.map { $0.profile == old ? SpaceKey(profile: new, space: $0.space) : $0 }.filter { seen.insert($0).inserted }
        _ = associate()
        save()
        forget(old)
    }

    // ---- the order ----

    // The profiles' spaces as their sets have them now (each profile's in its
    // own order) and which profiles are linked: the order resolved, new
    // profiles taken in, the linked ones seen now. Saved when anything lasting changed.
    @discardableResult func refresh(spaces: [String: [String]], linked: Set<String>) -> Bool {
        var changed = false
        let t = now()
        for p in Set(spaces.keys).union(linked).sorted() where info[p] == nil {
            var i = ProfileInfo()
            i.firstSeen = t + Double(info.count) * 0.001 // apart, in the order they're met
            i.lastSeen = linked.contains(p) ? t : 0
            info[p] = i
            changed = true
        }
        if changed { _ = associate() } // a new profile linked to the browser's, if it's read
        for p in linked {
            guard var i = info[p] else { continue }
            if i.hidden { i.hidden = false; changed = true } // it's back
            // Seen now: written at most once an hour (it only says how long it's been).
            if t - i.lastSeen > 3_600_000 { changed = true }
            i.lastSeen = t
            info[p] = i
        }
        let visible = spaces.filter { info[$0.key]?.hidden != true }
        let resolved = Self.resolve(stored: stored, spaces: visible, profiles: profiles)
        if resolved != stored { stored = resolved; changed = true }
        if changed { save() }
        return changed
    }

    // The slots rule (above). `spaces`: each profile's space ids in its own
    // order; `profiles`: in the order Margin first saw them.
    static func resolve(stored: [SpaceKey], spaces: [String: [String]], profiles: [String]) -> [SpaceKey] {
        var out = stored.filter { spaces[$0.profile]?.contains($0.space) ?? false }
        var seen = Set<SpaceKey>()
        out = out.filter { seen.insert($0).inserted }
        let known = profiles + spaces.keys.filter { !profiles.contains($0) }.sorted()
        for p in known {
            guard let own = spaces[p], !own.isEmpty else { continue }
            let slots = out.indices.filter { out[$0].profile == p }
            if slots.isEmpty {
                out += own.map { SpaceKey(profile: p, space: $0) }
                continue
            }
            // New ones: each right after the one before it in the profile's order.
            let placed = Set(slots.map { out[$0].space })
            for (n, id) in own.enumerated() where !placed.contains(id) {
                let key = SpaceKey(profile: p, space: id)
                let before = own[..<n].last { s in out.contains(SpaceKey(profile: p, space: s)) }
                if let before, let at = out.firstIndex(of: SpaceKey(profile: p, space: before)) {
                    out.insert(key, at: at + 1)
                } else if let first = out.firstIndex(where: { $0.profile == p }) {
                    out.insert(key, at: first)
                } else {
                    out.append(key)
                }
            }
            // Its places, filled in its own order.
            let places = out.indices.filter { out[$0].profile == p }
            for (i, at) in places.enumerated() { out[at] = SpaceKey(profile: p, space: own[i]) }
        }
        return out
    }
}
