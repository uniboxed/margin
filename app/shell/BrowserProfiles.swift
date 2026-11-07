// Spaces across a browser's profiles (PLAN.md §15, DATA.md "Spaces across
// profiles"): which profile each space is in, the one order of every
// profile's spaces the person controls, and each profile's name, emoji and
// color. One file per browser, beside its profiles' data sets:
//
//   data/<browser>/browser.json
//     { format, browser, order: [[profile, space]], profiles: { id: info }, switching: { closeWindows }, savedAt }
//
// `switching`: how a switch between profiles treats the window it leaves
// (app/HANDOFF.md §5): "Close windows to save memory" (`closeWindows`, off
// by default: the window stays open, parked out of sight). One value for the
// whole browser, so every profile's Settings show the same.
//
// A space is in the profile whose data set has it: nothing in a set names
// its profile. `order` is kept as the person left it and read against the
// sets each time (resolve()): a space no set has any more is left out; each
// profile's spaces fill the places its spaces had, in that profile's own
// order (its spaces' `order`), so a move made in one profile while the app
// wasn't there still shows; a new space goes right after the one before it
// in its profile's order (the first of its profile: before that profile's
// first); a profile not in the order yet comes last. A move here
// (move()) gives back the profile's own order when it changed, for the app
// to write into its set, so the profile's copy shows the same order alone.
//
// Profile names: with Full Disk Access, Safari's own (SafariProfiles.swift,
// `useBrowserNames`), kept in step with Safari, which win over a typed one;
// Edit Profile then keeps the emoji and color only (Margin never writes to
// Safari). Without it, the person names each profile once; until then
// "Default" for Safari's default profile (`s-default`) and "Profile N" for
// the others, in the order Margin first saw them. A profile deleted in Safari
// keeps the name Safari last gave it, as if typed.

import Foundation

nonisolated struct SpaceKey: Hashable, Comparable, CustomStringConvertible {
    let profile: String
    let space: String
    var description: String { "\(profile)/\(space)" }
    static func < (a: SpaceKey, b: SpaceKey) -> Bool { (a.profile, a.space) < (b.profile, b.space) }
}

struct ProfileInfo: Equatable {
    var name = ""
    var emoji = ""
    var color = ""
    var named = false // the person named it
    var firstSeen: Double = 0
    var lastSeen: Double = 0 // linked last (or now, while it is)
    var hidden = false // forgotten by the person: left out until its copy links again
    var browserId = "" // the browser's own id for the profile, once its name was read (Safari: its server_id)
    var browserName = "" // the name the browser last gave it

    var json: JSONObject {
        var o: JSONObject = ["name": name, "emoji": emoji, "color": color, "named": named, "firstSeen": firstSeen, "lastSeen": lastSeen, "hidden": hidden]
        if !browserId.isEmpty { o["browserId"] = browserId; o["browserName"] = browserName }
        return o
    }
    init() {}
    init(json o: JSONObject) {
        name = o["name"] as? String ?? ""
        emoji = o["emoji"] as? String ?? ""
        color = o["color"] as? String ?? ""
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
    // A profile's mark until it's given a color: one of these, by when Margin first saw it.
    static let colors = ["#6c5ce7", "#00b894", "#e17055", "#0984e3", "#fdcb6e", "#e84393", "#636e72", "#00cec9"]
    // Not linked for this long: the profile's menu says when it was last seen.
    static let staleMs: Double = 30 * 86_400_000

    let browser: String
    let url: URL?
    var now: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() }
    private(set) var stored: [SpaceKey] = [] // as the person left it
    private(set) var order: [SpaceKey] = [] // resolved against the sets (refresh)
    private(set) var info: [String: ProfileInfo] = [:]
    private(set) var saves = 0
    // "Close windows to save memory" (app/HANDOFF.md §5): the window a switch leaves is closed, not parked.
    private(set) var closeWindows = false
    // The browser's own names now (with the permission; not saved as such): profile → name and SF Symbol.
    private(set) var browserNames: [String: BrowserName] = [:]
    struct BrowserName: Equatable { var name: String; var symbol: String }

    // `root`: the data folder (DataStore.root); nil keeps it in memory (the unit tests).
    init(browser: String, root: URL?) {
        self.browser = browser
        url = root?.appendingPathComponent(DataStore.fileName(browser), isDirectory: true).appendingPathComponent("browser.json")
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
        closeWindows = (o["switching"] as? JSONObject)?["closeWindows"] as? Bool ?? false
        order = stored
    }

    func save() {
        saves += 1
        guard let url else { return }
        let body: JSONObject = [
            "format": Self.format, "browser": browser, "savedAt": now(),
            "order": stored.map { [$0.profile, $0.space] },
            "profiles": info.mapValues(\.json),
            "switching": ["closeWindows": closeWindows],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { return }
        do { try DataStore.writeAtomically(data, to: url) } catch { Diagnostics.warn("\(browser): browser.json not saved: \(error)") }
    }

    // ---- switching ----

    // "Close windows to save memory" turned on or off. True if it changed (saved then).
    @discardableResult func setCloseWindows(_ on: Bool) -> Bool {
        guard on != closeWindows else { return false }
        closeWindows = on
        save()
        return true
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

    func color(_ profile: String) -> String {
        if let c = info[profile]?.color, !c.isEmpty { return c }
        return Self.colors[(profiles.firstIndex(of: profile) ?? 0) % Self.colors.count]
    }

    // Named by the person (an empty name: back to the default). While the
    // browser's name is shown, the name is the browser's: only the emoji and color change.
    @discardableResult func rename(_ profile: String, name: String, emoji: String, color: String?) -> Bool {
        guard var i = info[profile] else { return false }
        if browserNames[profile] == nil {
            let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
            i.name = trimmed
            i.named = !trimmed.isEmpty
        }
        i.emoji = String(emoji.prefix(8))
        if let color, color.range(of: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", options: .regularExpression) != nil { i.color = color }
        info[profile] = i
        save()
        return true
    }

    // Forgotten: its spaces leave the list (its data stays) until its copy links again.
    @discardableResult func forget(_ profile: String) -> Bool {
        guard var i = info[profile], !i.hidden else { return false }
        i.hidden = true
        info[profile] = i
        order.removeAll { $0.profile == profile }
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
            if let margin = p.margin, names[margin] == nil { names[margin] = BrowserName(name: p.name, symbol: p.symbol) }
        }
        for id in info.keys.sorted() {
            guard var i = info[id] else { continue }
            let known = i.browserId.isEmpty ? nil : byId[i.browserId]
            if names[id] == nil, let known, !known.name.isEmpty { names[id] = BrowserName(name: known.name, symbol: known.symbol) }
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

    // `old`'s place taken by `new`: its name, emoji, color (the one it was
    // shown with), when it was first seen and its places in the order; `old`
    // forgotten (its data set was put away). Its copy linking again later
    // (a switch back) brings it back, and the set is carried back the same way.
    func carry(from old: String, to new: String) {
        guard old != new, let o = info[old] else { return }
        var n = info[new] ?? ProfileInfo()
        n.name = o.name
        n.named = o.named
        n.emoji = o.emoji
        n.color = o.color.isEmpty ? color(old) : o.color
        n.firstSeen = n.firstSeen == 0 ? o.firstSeen : min(n.firstSeen, o.firstSeen)
        n.lastSeen = max(n.lastSeen, o.lastSeen)
        n.hidden = false
        if n.browserId.isEmpty { (n.browserId, n.browserName) = (o.browserId, o.browserName) }
        info[new] = n
        var seen = Set<SpaceKey>()
        let moved = { (list: [SpaceKey]) in list.filter { $0.profile != new }.map { $0.profile == old ? SpaceKey(profile: new, space: $0.space) : $0 }.filter { seen.insert($0).inserted } }
        stored = moved(stored)
        seen = []
        order = moved(order)
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
        order = resolved
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

    // A space moved one place along (dir -1 or 1) in the whole order. The
    // profile's own order afterwards, if it changed (the app writes it into
    // the set), else nil. False if it can't move.
    func move(_ key: SpaceKey, by dir: Int) -> (moved: Bool, ownOrder: [String]?) {
        guard let at = order.firstIndex(of: key) else { return (false, nil) }
        let to = at + (dir < 0 ? -1 : 1)
        guard order.indices.contains(to) else { return (false, nil) }
        let before = order.filter { $0.profile == key.profile }.map(\.space)
        order.swapAt(at, to)
        stored = order
        save()
        let after = order.filter { $0.profile == key.profile }.map(\.space)
        return (true, after == before ? nil : after)
    }

    // The space before or after in the whole order, wrapping around; nil with one space.
    func neighbour(of key: SpaceKey, _ dir: Int) -> SpaceKey? {
        guard order.count > 1, let at = order.firstIndex(of: key) else { return nil }
        return order[(at + (dir < 0 ? -1 : 1) + order.count) % order.count]
    }

    // What a space key does in a window of `profile` showing `here` (the chained
    // aim, a moment after a key: ShellProfiles.swift spaceKey). nil: nothing
    // across profiles (only one has spaces): the copy's own `navigate`. `.own`:
    // a space of the window's own profile, from one of its own. `.across`: the
    // cross-profile switch (another profile's space, or on from an aim that's
    // already another profile's). `.held`: a held key's repeat that would go to
    // another profile, or on from one: nothing, so a held ⌃⌘→ starts at most one
    // switch of profile (and its full-screen windows) per press.
    enum SpaceStep: Equatable { case own(SpaceKey), across(SpaceKey), held }
    func spaceStep(from here: SpaceKey, profile: String, dir: Int, isRepeat: Bool) -> SpaceStep? {
        guard Set(order.map(\.profile)).count > 1, let next = neighbour(of: here, dir) else { return nil }
        if here.profile == profile, next.profile == profile { return .own(next) }
        return isRepeat ? .held : .across(next)
    }

    var profilesShown: [String] { profiles.filter { p in order.contains { $0.profile == p } } }

    // What an overlay of `profile`'s window draws besides its own state
    // (ui/host-app.js `across`): every shown profile, and every space in the
    // one order. `spaces`: each profile's spaces' values (name, emoji,
    // color); `counts`: profile → space → its tabs; `linked`; `switching`:
    // the cross-profile switch under way, if any.
    // `symbol`: a symbol's picture (ProfileSymbols.dataURL), for a profile with the browser's name.
    // `switchSettings`: whether "Close windows to save memory" means anything now (the handoff on, with
    // parking): false, it isn't sent, and Settings doesn't show it.
    func across(for profile: String, spaces: [String: [String: JSONObject]], counts: [String: [String: Int]], linked: Set<String>, switching: JSONObject? = nil,
                switchSettings: Bool = true, symbol: (String) -> String? = { _ in nil }) -> JSONObject {
        let t = now()
        let shown = profilesShown.isEmpty ? [profile] : profilesShown
        let list: [JSONObject] = (shown + (shown.contains(profile) ? [] : [profile])).map { p in
            let i = info[p] ?? ProfileInfo()
            var o: JSONObject = [
                "id": p, "name": name(p), "emoji": i.emoji, "color": color(p), "named": i.named,
                "here": p == profile, "linked": linked.contains(p),
                "lastSeen": i.lastSeen, "stale": !linked.contains(p) && i.lastSeen > 0 && t - i.lastSeen > Self.staleMs,
                "spaces": order.filter { $0.profile == p }.count,
            ]
            if let b = browserNames[p] {
                o["nameFrom"] = browser // the browser's name: Edit Profile shows it and leaves it
                if let picture = symbol(b.symbol) { o["symbol"] = picture }
            }
            return o
        }
        let entries: [JSONObject] = order.map { k in
            let v = spaces[k.profile]?[k.space] ?? [:]
            return ["profile": k.profile, "id": k.space, "name": v["name"] as? String ?? "", "emoji": v["emoji"] as? String ?? "",
                    "color": v["color"] as? String ?? "", "tabCount": counts[k.profile]?[k.space] ?? 0]
        }
        var out: JSONObject = ["v": 1, "profile": profile, "profiles": list, "spaces": entries]
        if switchSettings { out["switchSettings"] = ["closeWindows": closeWindows] }
        if let switching { out["switching"] = switching }
        return out
    }
}
