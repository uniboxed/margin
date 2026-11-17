// A browser's profiles (BrowserProfiles.swift), part of tests.swift's run: the order (the slots rule), the profiles'
// names and their file, a profile forgotten and back.
import Foundation

func profilesTests() {
    // ---- the slots rule ----
    func k(_ p: String, _ s: String) -> SpaceKey { SpaceKey(profile: p, space: s) }
    let stored = [k("A", "a1"), k("B", "b1"), k("A", "a2"), k("B", "b2")]
    check("order: as stored when the sets agree", BrowserProfiles.resolve(stored: stored, spaces: ["A": ["a1", "a2"], "B": ["b1", "b2"]], profiles: ["A", "B"]) == stored)
    check("order: a profile's own reorder fills its places", BrowserProfiles.resolve(stored: stored, spaces: ["A": ["a2", "a1"], "B": ["b1", "b2"]], profiles: ["A", "B"])
          == [k("A", "a2"), k("B", "b1"), k("A", "a1"), k("B", "b2")])
    check("order: a space no set has is left out", BrowserProfiles.resolve(stored: stored, spaces: ["A": ["a1"], "B": ["b1", "b2"]], profiles: ["A", "B"])
          == [k("A", "a1"), k("B", "b1"), k("B", "b2")])
    check("order: a new space right after the one before it in its profile", BrowserProfiles.resolve(stored: stored, spaces: ["A": ["a1", "a9", "a2"], "B": ["b1", "b2"]], profiles: ["A", "B"])
          == [k("A", "a1"), k("A", "a9"), k("B", "b1"), k("A", "a2"), k("B", "b2")])
    check("order: a new first space before its profile's first", BrowserProfiles.resolve(stored: stored, spaces: ["A": ["a0", "a1", "a2"], "B": ["b1", "b2"]], profiles: ["A", "B"]).prefix(2) == [k("A", "a0"), k("A", "a1")])
    check("order: a profile not in it yet comes last, in its own order", BrowserProfiles.resolve(stored: stored, spaces: ["A": ["a1", "a2"], "B": ["b1", "b2"], "C": ["c2", "c1"]], profiles: ["A", "B", "C"]).suffix(2) == [k("C", "c2"), k("C", "c1")])
    check("order: nothing stored: profile by profile", BrowserProfiles.resolve(stored: [], spaces: ["B": ["b1"], "A": ["a1", "a2"]], profiles: ["A", "B"]) == [k("A", "a1"), k("A", "a2"), k("B", "b1")])
    check("order: a key twice is kept once", BrowserProfiles.resolve(stored: stored + [k("A", "a1")], spaces: ["A": ["a1", "a2"], "B": ["b1", "b2"]], profiles: ["A", "B"]) == stored)

    // ---- profiles, names, the file ----
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-profiles-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    var clockNow: Double = 1_000_000
    let bp = BrowserProfiles(browser: "safari", root: root)
    bp.now = { clockNow }
    bp.refresh(spaces: ["s-default": ["home", "work"]], linked: ["s-default"])
    clockNow += 10
    bp.refresh(spaces: ["s-default": ["home", "work"], "s-2": ["job"], "s-3": ["fun"]], linked: ["s-default", "s-2"])
    check("profiles: in the order first seen", bp.profiles == ["s-default", "s-2", "s-3"], "\(bp.profiles)")
    check("profiles: default names", bp.name("s-default") == "Default" && bp.name("s-2") == "Profile 2" && bp.name("s-3") == "Profile 3", "\(bp.name("s-2")) \(bp.name("s-3"))")
    check("order: the new profiles after", bp.stored.map(\.description) == ["s-default/home", "s-default/work", "s-2/job", "s-3/fun"], "\(bp.stored)")
    bp.refresh(spaces: ["s-default": ["work", "home"], "s-2": ["job"], "s-3": ["fun"]], linked: ["s-default", "s-2"])
    check("order: a profile's own reorder kept in its places", bp.stored.map(\.description) == ["s-default/work", "s-default/home", "s-2/job", "s-3/fun"], "\(bp.stored)")
    let again = BrowserProfiles(browser: "safari", root: root)
    check("the file: the order and the profiles read back", again.stored == bp.stored && again.name("s-2") == "Profile 2" && again.profiles == bp.profiles,
          "\(again.stored) \(again.profiles)")
    check("the file: data/safari/browser.json", FileManager.default.fileExists(atPath: root.appendingPathComponent("safari/browser.json").path))
    let written = (try? JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("safari/browser.json")))) as? JSONObject
    check("the file: no switch settings, no emoji or color (gone with the overlay)", written?["switching"] == nil
          && (written?["profiles"] as? JSONObject ?? [:]).values.allSatisfy { ($0 as? JSONObject)?["emoji"] == nil && ($0 as? JSONObject)?["color"] == nil }, "\(written ?? [:])")
    // A file an earlier version wrote (a typed name, an emoji and color, the switch setting): read, the name kept.
    var older = written ?? [:]
    older["switching"] = ["closeWindows": true]
    var olderProfiles = older["profiles"] as? JSONObject ?? [:]
    olderProfiles["s-2"] = (olderProfiles["s-2"] as? JSONObject ?? [:]).merging(["name": "Job", "named": true, "emoji": "💼", "color": "#00b894"]) { $1 }
    older["profiles"] = olderProfiles
    try? JSONSerialization.data(withJSONObject: older).write(to: root.appendingPathComponent("safari/browser.json"))
    let typed = BrowserProfiles(browser: "safari", root: root)
    check("the file: an earlier version's typed name is still the profile's", typed.name("s-2") == "Job" && typed.stored == bp.stored && typed.name("s-3") == "Profile 3")
    check("forget: marked, once", again.forget("s-3") && again.info["s-3"]?.hidden == true && !again.forget("s-3"))
    again.refresh(spaces: ["s-default": ["work", "home"], "s-2": ["job"], "s-3": ["fun"]], linked: ["s-default"])
    check("forget: its spaces out of the order while it isn't linked", !again.stored.contains { $0.profile == "s-3" })
    again.refresh(spaces: ["s-default": ["work", "home"], "s-2": ["job"], "s-3": ["fun"]], linked: ["s-default", "s-3"])
    check("forget: back once its copy links", again.stored.contains(k("s-3", "fun")) && again.info["s-3"]?.hidden == false)
}
