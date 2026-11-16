// A browser's profiles (BrowserProfiles.swift), part of tests.swift's run: the one order (the slots rule, moves,
// wrapping), the profiles' names and their file, and `across`.
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
    check("profiles: colors until chosen, one each", bp.color("s-default") != bp.color("s-2") && bp.color("s-2").hasPrefix("#"))
    check("order: the new profiles after", bp.order.map(\.description) == ["s-default/home", "s-default/work", "s-2/job", "s-3/fun"], "\(bp.order)")
    check("rename", bp.rename("s-2", name: "  Job  ", emoji: "💼", color: "#00b894") && bp.name("s-2") == "Job" && bp.color("s-2") == "#00b894")
    check("rename: a bad color left as it was", bp.rename("s-2", name: "Job", emoji: "", color: "red") && bp.color("s-2") == "#00b894")
    check("rename: an empty name is the default again", bp.rename("s-3", name: " ", emoji: "", color: nil) && bp.name("s-3") == "Profile 3")
    check("rename: an unknown profile", !bp.rename("s-9", name: "x", emoji: "", color: nil))
    let moved = bp.move(k("s-2", "job"), by: -1)
    check("move: one place along, the profile's own order unchanged when it has one space", moved.moved && moved.ownOrder == nil && bp.order.map(\.description) == ["s-default/home", "s-2/job", "s-default/work", "s-3/fun"])
    let swapped = bp.move(k("s-default", "work"), by: -1)
    check("move: past another profile's space, its own order unchanged", swapped.moved && swapped.ownOrder == nil && bp.order.map(\.description) == ["s-default/home", "s-default/work", "s-2/job", "s-3/fun"], "\(swapped) \(bp.order)")
    let swapped2 = bp.move(k("s-default", "work"), by: -1)
    check("move: past a space of its own profile, that profile's order given back", swapped2.ownOrder == ["work", "home"])
    check("move: not past the ends", !bp.move(k("s-3", "fun"), by: 1).moved && !bp.move(k("s-default", "work"), by: -1).moved)
    check("neighbour: wraps around both ways", bp.neighbour(of: k("s-3", "fun"), 1) == k("s-default", "work") && bp.neighbour(of: k("s-default", "work"), -1) == k("s-3", "fun"))
    let again = BrowserProfiles(browser: "safari", root: root)
    check("the file: the order, names and colors read back", again.order == bp.order && again.name("s-2") == "Job" && again.color("s-2") == "#00b894" && again.profiles == bp.profiles,
          "\(again.order) \(again.profiles)")
    check("the file: data/safari/browser.json", FileManager.default.fileExists(atPath: root.appendingPathComponent("safari/browser.json").path))
    check("forget: its spaces out of the list", again.forget("s-3") && !again.order.contains { $0.profile == "s-3" } && !again.forget("s-3"))
    again.refresh(spaces: ["s-default": ["work", "home"], "s-2": ["job"], "s-3": ["fun"]], linked: ["s-default"])
    check("forget: stays out while it isn't linked", !again.order.contains { $0.profile == "s-3" })
    again.refresh(spaces: ["s-default": ["work", "home"], "s-2": ["job"], "s-3": ["fun"]], linked: ["s-default", "s-3"])
    check("forget: back once its copy links", again.order.contains(k("s-3", "fun")) && again.info["s-3"]?.hidden == false)
    let across = again.across(for: "s-2", spaces: ["s-2": ["job": ["name": "Job board", "emoji": "📋", "color": "#000"]]], counts: ["s-2": ["job": 3]], linked: ["s-default"])
    let list = across["profiles"] as? [JSONObject] ?? []
    let spaces = across["spaces"] as? [JSONObject] ?? []
    check("across: this window's profile, every shown profile with its name, here and linked", across["profile"] as? String == "s-2" && list.count == 3
          && list.first { $0["id"] as? String == "s-2" }?["here"] as? Bool == true && list.first { $0["id"] as? String == "s-2" }?["name"] as? String == "Job"
          && list.first { $0["id"] as? String == "s-default" }?["linked"] as? Bool == true, "\(list)")
    check("across: every space in the order, with its name and tabs", spaces.count == 4 && spaces.first { $0["id"] as? String == "job" }?["tabCount"] as? Int == 3
          && spaces.first { $0["id"] as? String == "job" }?["name"] as? String == "Job board", "\(spaces)")
    clockNow += BrowserProfiles.staleMs + 1
    let stale = (again.across(for: "s-default", spaces: [:], counts: [:], linked: ["s-default"])["profiles"] as? [JSONObject] ?? []).first { $0["id"] as? String == "s-2" }
    check("across: a profile not seen for a month says so", stale?["stale"] as? Bool == true)

}
