// Spaces across profiles (BrowserProfiles.swift, ProfileSwitch.swift), part of
// tests.swift's run: the one order (the slots rule, moves, wrapping), the
// profiles' names and their file, `across` for an overlay, and the
// cross-profile switch's state machine against a fake world (links, window
// lists, what's in front) and a fake clock: the switch that works, a window
// that comes back normal, a create that fails or times out (and its late
// window), a window that never comes to the front, the new or the old window
// closed by the person, a switch asked mid-switch, Safari quitting, a profile
// whose copy isn't running, and macOS dropping to the desktop. This is the
// machine's close-based switch: FakeWorld is no HandoffWorld, so every switch
// here runs it exactly as before the handoff (no drafts asked, no freeze, the
// same phases); the handoff itself is handoff-tests.swift's.
import Foundation

final class FakeClock: SwitchClock {
    final class T: SwitchTimer {
        var at: Double; var fire: () -> Void; var cancelled = false
        init(_ at: Double, _ fire: @escaping () -> Void) { self.at = at; self.fire = fire }
        func cancel() { cancelled = true }
    }
    var t: Double = 1000
    var timers: [T] = []
    func now() -> Double { t }
    func after(_ seconds: Double, _ fire: @escaping () -> Void) -> SwitchTimer {
        let timer = T(t + seconds, fire)
        timers.append(timer)
        return timer
    }
    // Time passes: the timers due fire in order (each may add more).
    func advance(_ seconds: Double) {
        let end = t + seconds
        while let next = timers.filter({ !$0.cancelled && $0.at <= end }).min(by: { $0.at < $1.at }) {
            t = max(t, next.at)
            next.cancelled = true
            next.fire()
        }
        t = end
        timers.removeAll { $0.cancelled }
    }
}

final class FakeWorld: SwitchWorld {
    var off: Set<String> = [] // profiles Margin is turned off in (the browser's settings)
    func marginOff(_ profile: String) -> Bool { off.contains(profile) }
    struct Req { let profile: String; let type: String; let payload: JSONObject; let done: (JSONObject?, String?) -> Void }
    var linked: Set<String> = []
    var wins: [String: [(id: Int, state: String)]] = [:]
    var front: (String, Int)?
    var requests: [Req] = []
    var events: [ProfileSwitch.Event] = []
    var answerCreate = false // answer openSpaceWindow at once (with createState)
    var createState = "fullscreen"
    var nextWindow = 50

    func isLinked(_ profile: String) -> Bool { linked.contains(profile) }
    func request(_ profile: String, _ type: String, _ payload: JSONObject, windowId: Int?, done: @escaping (JSONObject?, String?) -> Void) {
        requests.append(Req(profile: profile, type: type, payload: payload, done: done))
        switch type {
        case "closeWindow":
            let id = int(payload["windowId"]) ?? -1
            wins[profile]?.removeAll { $0.id == id }
            done([:], nil)
        case "focusWindow":
            let id = int(payload["windowId"]) ?? -1
            if payload["fullscreen"] as? Bool == true, let i = wins[profile]?.firstIndex(where: { $0.id == id }) { wins[profile]![i].state = "fullscreen" }
            done([:], nil)
        case "setSpace":
            done([:], nil)
        case "openSpaceWindow":
            if answerCreate { answer(requests.count - 1, state: createState) }
        default:
            done(nil, "unknown")
        }
    }
    // The copy's answer to a create: a new window, in its list.
    func answer(_ index: Int, state: String = "fullscreen") {
        let r = requests[index]
        let id = nextWindow
        nextWindow += 1
        wins[r.profile, default: []].append((id, state))
        r.done(["windowId": id, "state": state], nil)
    }
    func windows(of profile: String) -> [(id: Int, state: String)] { wins[profile] ?? [] }
    func inFront(_ profile: String, windowId: Int) -> Bool { front.map { $0.0 == profile && $0.1 == windowId } ?? false }
    func switchChanged(_ event: ProfileSwitch.Event) { events.append(event) }
    func types(_ profile: String? = nil) -> [String] { requests.filter { profile == nil || $0.profile == profile }.map(\.type) }
}

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

    switchTests()
}

func switchTests() {
    let A = "safari:A", B = "safari:B", C = "safari:C"
    func setup(_ build: (FakeWorld) -> Void = { _ in }) -> (FakeWorld, FakeClock, ProfileSwitch) {
        let w = FakeWorld()
        w.linked = [A, B, C]
        w.wins = [A: [(10, "fullscreen")]]
        w.front = (A, 10)
        build(w)
        let c = FakeClock()
        return (w, c, ProfileSwitch(world: w, clock: c))
    }
    let toB = ProfileSwitch.Target(profile: B, space: "b1")

    do { // it works
        let (w, c, s) = setup()
        s.start(toB, from: A, windowId: 10)
        check("switch: the target's copy asked to open the space's window, full screen", w.types() == ["openSpaceWindow"] && w.requests[0].profile == B
              && w.requests[0].payload["spaceId"] as? String == "b1" && w.requests[0].payload["fullscreen"] as? Bool == true && s.phase == .creating)
        w.answer(0)
        c.advance(0.3)
        check("switch: waits for the new window in front, nothing closed yet", s.phase == .settling && !w.types().contains("closeWindow"))
        w.front = (B, 50)
        c.advance(0.1)
        check("switch: the old window closed once the new one is full screen and in front", w.requests.last?.type == "closeWindow" && w.requests.last?.profile == A && int(w.requests.last?.payload["windowId"]) == 10)
 c.advance(0.6)
        check("switch: done, the new window still in front half a second after", !s.busy && w.events == [.started(toB), .done(toB)] && w.wins[A]?.isEmpty == true, "\(w.events)")
        check("switch: a world that can't hand off: the close-based switch, no drafts asked, no handoff run", s.run == nil && !w.types().contains("windowDrafts")
              && w.types() == ["openSpaceWindow", "closeWindow"], "\(w.types())")
    }
    do { // a normal window: asked for full screen once
        let (w, c, s) = setup { $0.answerCreate = true; $0.createState = "normal" }
        s.start(toB, from: A, windowId: 10)
        c.advance(0.2)
        check("switch, normal window: not asked at once", !w.types().contains("focusWindow"))
        c.advance(0.4)
        check("switch, normal window: windows.update to full screen, once", w.types().filter { $0 == "focusWindow" }.count == 1 && w.requests.last?.payload["fullscreen"] as? Bool == true)
        w.front = (B, 50)
        c.advance(0.7)
        check("switch, normal window: then the same as any", !s.busy && w.events.last == .done(toB) && w.types().filter { $0 == "focusWindow" }.count == 1)
    }
    do { // refused
        let (w, c, s) = setup()
        s.start(toB, from: A, windowId: 10)
        w.requests[0].done(nil, "no such space")
        c.advance(0.2)
        check("switch, create refused: failed, nothing closed", !s.busy && !w.types().contains("closeWindow") && { if case .failed(toB, _) = w.events.last! { return true }; return false }())
    }
    do { // timed out, then a late window
        let (w, c, s) = setup()
        s.start(toB, from: A, windowId: 10)
        c.advance(8.1)
        check("switch, create too slow: failed after 8 s, nothing closed", !s.busy && !w.types().contains("closeWindow") && { if case .failed = w.events.last! { return true }; return false }())
        w.answer(0)
        check("switch, create too slow: its late window is closed (one window at a time)", w.requests.last?.type == "closeWindow" && w.requests.last?.profile == B && int(w.requests.last?.payload["windowId"]) == 50 && w.wins[A]?.count == 1)
    }
    do { // never in front
        let (w, c, s) = setup { $0.answerCreate = true }
        s.start(toB, from: A, windowId: 10)
        c.advance(6.2)
        let closed = w.requests.filter { $0.type == "closeWindow" }
        check("switch, never in front: the new window closed, the old one brought back, failed", !s.busy && closed.count == 1 && closed[0].profile == B
              && w.requests.contains { $0.type == "focusWindow" && $0.profile == A && int($0.payload["windowId"]) == 10 } && { if case .failed = w.events.last! { return true }; return false }())
    }
    do { // the person closes the new window
        let (w, c, s) = setup { $0.answerCreate = true }
        s.start(toB, from: A, windowId: 10)
        c.advance(0.6)
        w.wins[B] = []
        c.advance(0.1)
        check("switch, new window closed by the person: cancelled, the old one stays and comes back", !s.busy && w.events.last == .cancelled(toB) && !w.types().contains("closeWindow")
              && w.requests.contains { $0.type == "focusWindow" && $0.profile == A })
    }
    do { // the person closes the old window
        let (w, c, s) = setup { $0.answerCreate = true }
        s.start(toB, from: A, windowId: 10)
        w.wins[A] = []
        w.front = (B, 50)
        c.advance(0.7)
        check("switch, old window closed by the person: nothing to close, done", !s.busy && w.events.last == .done(toB) && !w.types().contains("closeWindow"))
    }
    do { // switching again mid-switch
        let (w, c, s) = setup { $0.answerCreate = true }
        s.start(toB, from: A, windowId: 10)
        s.start(.init(profile: B, space: "b2"), from: A, windowId: 10)
        s.start(.init(profile: C, space: "c1"), from: A, windowId: 10)
        check("switch again: waits, the last asked kept", s.queued == .init(profile: C, space: "c1") && w.types() == ["openSpaceWindow"])
        w.front = (B, 50)
        c.advance(0.7)
        check("switch again: after the first, on to C from B's new window", s.busy && s.target?.profile == C && w.requests.last?.type == "openSpaceWindow" && w.requests.last?.profile == C)
        w.front = (C, 51)
        c.advance(0.7)
        check("switch again: B's window closed in turn, one window left", !s.busy && w.requests.contains { $0.type == "closeWindow" && $0.profile == B && int($0.payload["windowId"]) == 50 }
              && (w.wins[A]?.count ?? 0) + (w.wins[B]?.count ?? 0) + (w.wins[C]?.count ?? 0) == 1, "\(w.wins)")
    }
    do { // the same profile asked mid-switch: its space, in the new window
        let (w, c, s) = setup { $0.answerCreate = true }
        s.start(toB, from: A, windowId: 10)
        s.start(.init(profile: B, space: "b2"), from: A, windowId: 10)
        w.front = (B, 50)
        c.advance(0.7)
        check("switch again, same profile: setSpace in the new window", !s.busy && w.requests.last?.type == "setSpace" && w.requests.last?.profile == B
              && int(w.requests.last?.payload["windowId"]) == 50 && w.requests.last?.payload["spaceId"] as? String == "b2")
    }
    do { // Safari quits mid-switch
        let (w, c, s) = setup()
        s.start(toB, from: A, windowId: 10)
        w.linked = []
        c.advance(0.1)
        let count = w.requests.count
        w.answer(0)
        c.advance(1)
        check("switch, Safari quit: ended with nothing more asked", !s.busy && { if case .failed = w.events.last! { return true }; return false }()
              && w.requests.count == count + 1 && w.requests.last?.type == "closeWindow", "\(w.types())") // only the late window's close (its copy's gone: harmless)
    }
    do { // Margin turned off in the target's profile (Safari did, as Margin updated: seen 2026-11-08)
        let (w, _, s) = setup { $0.linked = [A]; $0.off = [B] }
        s.start(toB, from: A, windowId: 10)
        check("switch, Margin off in that profile: failed at once and said, no window opened, nothing asked",
              !s.busy && w.events.count == 2 && { if case .failed(_, let why) = w.events.last!, why.contains("turned off") { return true }; return false }() && w.requests.isEmpty, "\(w.events)")
    }
    do { // the target's copy isn't running
        let (w, c, s) = setup { $0.linked = [A] }
        s.start(toB, from: A, windowId: 10)
        check("switch, profile not running: the person is asked to open one of its windows", s.phase == .waitingForProfile && w.events == [.started(toB), .needsProfile(toB)] && w.requests.isEmpty)
        c.advance(5)
        w.linked.insert(B)
        w.wins[B] = [(70, "normal")]
        c.advance(0.1)
        check("switch, profile opened by the person: its window shows the space, full screen", s.phase == .settling && w.types(B) == ["focusWindow", "setSpace"]
              && w.requests.last?.payload["spaceId"] as? String == "b1")
        w.front = (B, 70)
        c.advance(0.7)
        check("switch, profile opened by the person: the old window closed, done", !s.busy && w.events.last == .done(toB) && w.types(A) == ["closeWindow"])
    }
    do { // never opened
        let (w, c, s) = setup { $0.linked = [A] }
        s.start(toB, from: A, windowId: 10)
        c.advance(91)
        check("switch, profile never opened: gave up, nothing done", !s.busy && w.requests.isEmpty && { if case .failed = w.events.last! { return true }; return false }())
        s.start(toB, from: A, windowId: 10)
        s.start(.init(profile: A, space: "a1"), from: A, windowId: 10)
        check("switch, back to where it started while waiting: cancelled", !s.busy && w.events.last == .cancelled(toB))
    }
    do { // macOS drops to the desktop after the close
        let (w, c, s) = setup { $0.answerCreate = true }
        s.start(toB, from: A, windowId: 10)
        w.front = (B, 50)
        c.advance(0.1)
        w.front = nil // the desktop
        c.advance(1.3)
        check("switch, desktop: the new window focused again", s.busy && w.requests.last?.type == "focusWindow" && w.requests.last?.profile == B && int(w.requests.last?.payload["windowId"]) == 50)
        w.front = (B, 50)
        c.advance(0.6)
        check("switch, desktop: in front again, done", !s.busy && w.events.last == .done(toB))
        let (w2, c2, s2) = setup { $0.answerCreate = true }
        s2.start(toB, from: A, windowId: 10)
        w2.front = (B, 50)
        c2.advance(0.1)
        w2.front = nil
        c2.advance(5)
        check("switch, desktop for good: two tries, then the person is told", !s2.busy && w2.types(B).filter { $0 == "focusWindow" }.count == 2 && { if case .failed = w2.events.last! { return true }; return false }())
    }
    do { // a window of the profile is there already
        let (w, c, s) = setup { $0.wins[B] = [(60, "fullscreen")] }
        s.start(toB, from: A, windowId: 10)
        check("switch, its window there: focused and shown, nothing made", w.types(B) == ["focusWindow", "setSpace"] && s.phase == .settling)
        c.advance(6.2)
        check("switch, its window there but never in front: not closed by the failure", !w.types(B).contains("closeWindow") && !s.busy)
    }
}
